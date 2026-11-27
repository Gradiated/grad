package grad

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Wire types re-exported for convenience.
type (
	// Message is one chat message: grad.Message{Role: "user", Content: "..."}.
	Message = generated.ChatMessage
	// Trajectory is one dataset record (chat, preference pair, triplet, ...).
	Trajectory = generated.DatasetRecord
	// Record is an alias of Trajectory.
	Record = generated.DatasetRecord
	// ImportJob is the status of a dataset import.
	ImportJob = generated.ImportJob
	// RenderResult shows how records render with a model's chat template.
	RenderResult = generated.RenderDatasetResponse
)

// TrajectoryOption customizes TrajectoryFromMessages.
type TrajectoryOption func(*Trajectory)

// WithSessionID groups records of one conversation for the train/eval split.
func WithSessionID(id string) TrajectoryOption { return func(t *Trajectory) { t.SessionID = &id } }

// WithGroupID groups preference pairs.
func WithGroupID(id string) TrajectoryOption { return func(t *Trajectory) { t.GroupID = &id } }

// WithMetadata attaches metadata (for example {"model": "qwen/qwen3-8b"}).
func WithMetadata(m map[string]any) TrajectoryOption {
	return func(t *Trajectory) { t.Metadata = m }
}

// TrajectoryFromMessages builds a chat record. Scores is non-nil so you can set traj.Scores["name"] = 1.0.
func TrajectoryFromMessages(messages []Message, opts ...TrajectoryOption) Trajectory {
	t := Trajectory{Messages: messages, Scores: map[string]float64{}}
	for _, opt := range opts {
		opt(&t)
	}
	return t
}

// DatasetRef names a dataset: a *Dataset, or DatasetName("name").
type DatasetRef interface {
	datasetName() string
}

// DatasetName refers to a dataset by name.
type DatasetName string

func (n DatasetName) datasetName() string { return string(n) }

// Dataset is a versioned collection of records.
type Dataset struct {
	generated.Dataset
	c *Client
}

func (d *Dataset) datasetName() string {
	if d == nil {
		return ""
	}
	return d.Name
}

// DatasetsService manages datasets.
type DatasetsService struct{ c *Client }

func (c *Client) dataset(d *generated.Dataset) *Dataset { return &Dataset{Dataset: *d, c: c} }

// Create creates an empty dataset (ConflictError if the name exists).
func (s *DatasetsService) Create(ctx context.Context, name string, opts ...PushOption) (*Dataset, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	o := pushOptions(opts)
	d, err := api.CreateDataset(ctx, &generated.CreateDatasetRequest{Name: name, Metadata: o.metadata})
	if err != nil {
		return nil, err
	}
	return s.c.dataset(d), nil
}

// Get fetches a dataset by name.
func (s *DatasetsService) Get(ctx context.Context, name string) (*Dataset, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	d, err := api.GetDataset(ctx, name)
	if err != nil {
		return nil, err
	}
	return s.c.dataset(d), nil
}

// List iterates over every dataset, fetching pages as needed.
func (s *DatasetsService) List(ctx context.Context) iter.Seq2[*Dataset, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Dataset, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListDatasets(ctx, &generated.ListDatasetsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Dataset, len(page.Data))
		for i := range page.Data {
			out[i] = s.c.dataset(&page.Data[i])
		}
		return out, page.NextCursor, nil
	})
}

type pushConfig struct {
	metadata  map[string]any
	batchSize int
	maxBytes  int
}

// PushOption configures Push, PushFile and Create.
type PushOption func(*pushConfig)

// WithDatasetMetadata sets dataset metadata.
func WithDatasetMetadata(m map[string]any) PushOption { return func(p *pushConfig) { p.metadata = m } }

// WithBatchSize caps records per request (default 1000).
func WithBatchSize(n int) PushOption { return func(p *pushConfig) { p.batchSize = n } }

// WithBatchBytes caps the JSON size of one request (default 8 MB).
func WithBatchBytes(n int) PushOption { return func(p *pushConfig) { p.maxBytes = n } }

func pushOptions(opts []PushOption) *pushConfig {
	p := &pushConfig{batchSize: 1000, maxBytes: 8 << 20}
	for _, opt := range opts {
		if opt != nil {
			opt(p)
		}
	}
	if p.batchSize <= 0 {
		p.batchSize = 1000
	}
	if p.maxBytes <= 0 {
		p.maxBytes = 8 << 20
	}
	return p
}

type batcher struct {
	s       *DatasetsService
	ctx     context.Context
	name    string
	cfg     *pushConfig
	pending []json.RawMessage
	size    int
	last    *generated.Dataset
	pushed  int
}

func (b *batcher) add(record any) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("grad: encoding record %d: %w", b.pushed+len(b.pending), err)
	}
	if len(b.pending) > 0 && (len(b.pending) >= b.cfg.batchSize || b.size+len(raw) > b.cfg.maxBytes) {
		if err := b.flush(); err != nil {
			return err
		}
	}
	b.pending = append(b.pending, raw)
	b.size += len(raw) + 1
	return nil
}

func (b *batcher) flush() error {
	if len(b.pending) == 0 {
		return nil
	}
	api, err := b.s.c.api()
	if err != nil {
		return err
	}
	records := make([]Trajectory, len(b.pending))
	for i, raw := range b.pending {
		if err := json.Unmarshal(raw, &records[i]); err != nil {
			return fmt.Errorf("grad: record %d is not a valid record: %w", b.pushed+i, err)
		}
	}
	body := &generated.PushDatasetRequest{Records: records}
	if b.last == nil {
		body.Metadata = b.cfg.metadata
	}
	d, err := api.PushDatasetRecords(b.ctx, b.name, body)
	if err != nil {
		return err
	}
	b.last = d
	b.pushed += len(b.pending)
	b.pending, b.size = b.pending[:0], 0
	return nil
}

func (b *batcher) done() (*Dataset, error) {
	if err := b.flush(); err != nil {
		return nil, err
	}
	if b.last == nil {
		return nil, newError("empty_push", "no records to push to dataset %q", b.name)
	}
	return b.s.c.dataset(b.last), nil
}

// Push appends records (creating the dataset if needed), in batches of at most 1000 records / 8 MB.
// Each batch creates a new dataset version.
func (s *DatasetsService) Push(ctx context.Context, name string, records []Trajectory, opts ...PushOption) (*Dataset, error) {
	b := &batcher{s: s, ctx: ctx, name: name, cfg: pushOptions(opts)}
	for i := range records {
		if err := b.add(&records[i]); err != nil {
			return nil, err
		}
	}
	return b.done()
}

// PushFile streams a JSONL file of records into the dataset in batches.
// For Parquet, provider exports or very large files use Dataset.ImportFile.
func (s *DatasetsService) PushFile(ctx context.Context, name, path string, opts ...PushOption) (*Dataset, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	defer f.Close()
	b := &batcher{s: s, ctx: ctx, name: name, cfg: pushOptions(opts)}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	line := 0
	for sc.Scan() {
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		if !json.Valid([]byte(text)) {
			return nil, newError("invalid_jsonl", "%s:%d is not valid JSON", path, line)
		}
		if err := b.add(json.RawMessage(text)); err != nil {
			return nil, err
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("grad: reading %s: %w", path, err)
	}
	return b.done()
}

type recordsConfig struct {
	version  int
	pageSize int
}

// RecordsOption configures Records.
type RecordsOption func(*recordsConfig)

// AtVersion reads a specific dataset version (default: the latest).
func AtVersion(v int) RecordsOption { return func(r *recordsConfig) { r.version = v } }

// WithPageSize sets records fetched per request.
func WithPageSize(n int) RecordsOption { return func(r *recordsConfig) { r.pageSize = n } }

// Records iterates over a dataset's records.
func (s *DatasetsService) Records(ctx context.Context, name string, opts ...RecordsOption) iter.Seq2[Trajectory, error] {
	cfg := &recordsConfig{}
	for _, opt := range opts {
		opt(cfg)
	}
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]Trajectory, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListDatasetRecords(ctx, name, &generated.ListDatasetRecordsParams{Version: optInt(cfg.version), Limit: optInt(cfg.pageSize), Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		return page.Data, page.NextCursor, nil
	})
}

// RenderOptions configures Render; zero values use the server defaults.
type RenderOptions struct {
	Model            string
	TrainOn          string
	Thinking         string
	PreserveThinking bool
	Limit            int
}

// Render shows how records tokenize with a model's chat template and which tokens train.
func (s *DatasetsService) Render(ctx context.Context, name string, o RenderOptions) (*RenderResult, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	body := &generated.RenderDatasetRequest{Model: optString(o.Model), Limit: optInt(o.Limit)}
	if o.TrainOn != "" {
		body.TrainOn = ptr(generated.RenderDatasetRequestTrainOn(o.TrainOn))
	}
	if o.Thinking != "" {
		body.Thinking = ptr(generated.RenderDatasetRequestThinking(o.Thinking))
	}
	if o.PreserveThinking {
		body.PreserveThinking = ptr(true)
	}
	return api.RenderDataset(ctx, name, body)
}

// HFOptions selects a Hugging Face dataset split and maps its columns.
type HFOptions struct {
	// Name of the grad dataset (default derived from repo, subset and split).
	Name string
	// Subset is the Hugging Face config name.
	Subset   string
	Split    string
	Revision string
	Limit    int
	// Column mapping.
	Messages, Prompt, Completion, Chosen, Rejected, Answer, Query, Positive string
	// Connector forces a trace connector (default auto).
	Connector string
	// Secret holds a Hugging Face token for gated or private datasets.
	Secret SecretLike
}

func (o HFOptions) source(repo string) generated.ImportSource {
	src := generated.ImportSource{Kind: generated.ImportSourceKindHF, Repo: &repo, Split: optString(o.Split), Config: optString(o.Subset), Revision: optString(o.Revision), Limit: optInt(o.Limit)}
	cols := generated.HFColumnMapping{Messages: optString(o.Messages), Prompt: optString(o.Prompt), Completion: optString(o.Completion), Chosen: optString(o.Chosen),
		Rejected: optString(o.Rejected), Answer: optString(o.Answer), Query: optString(o.Query), Positive: optString(o.Positive)}
	if cols != (generated.HFColumnMapping{}) {
		src.Columns = &cols
	}
	if o.Secret != nil {
		src.Secret = optString(o.Secret.secretName())
	}
	return src
}

var slugUnsafe = regexp.MustCompile(`[^a-z0-9._-]+`)

func hfDatasetName(repo string, o HFOptions) string {
	parts := []string{"hf", repo}
	if o.Subset != "" {
		parts = append(parts, o.Subset)
	}
	if o.Split != "" {
		parts = append(parts, o.Split)
	}
	name := strings.Trim(slugUnsafe.ReplaceAllString(strings.ToLower(strings.Join(parts, "-")), "-"), "-._")
	if len(name) > 64 {
		name = strings.TrimRight(name[:64], "-._")
	}
	return name
}

// FromHF imports a Hugging Face dataset (run by the trainer worker) and waits for it.
func (s *DatasetsService) FromHF(ctx context.Context, repo string, o HFOptions, opts ...WaitOption) (*Dataset, error) {
	name := o.Name
	if name == "" {
		name = hfDatasetName(repo, o)
	}
	d, err := s.Create(ctx, name)
	if err != nil {
		var conflict *ConflictError
		if !errors.As(err, &conflict) {
			return nil, err
		}
		if d, err = s.Get(ctx, name); err != nil {
			return nil, err
		}
	}
	if _, err := d.ImportHF(ctx, repo, o).Wait(ctx, opts...); err != nil {
		return nil, err
	}
	return d, d.Refresh(ctx)
}

// Refresh reloads the dataset.
func (d *Dataset) Refresh(ctx context.Context) error {
	fresh, err := d.c.Datasets.Get(ctx, d.Name)
	if err != nil {
		return err
	}
	d.Dataset = fresh.Dataset
	return nil
}

// Count returns the current record count (refreshing the dataset).
func (d *Dataset) Count(ctx context.Context) (int, error) {
	if err := d.Refresh(ctx); err != nil {
		return 0, err
	}
	return d.RecordCount, nil
}

// Push appends records to this dataset.
func (d *Dataset) Push(ctx context.Context, records []Trajectory, opts ...PushOption) error {
	fresh, err := d.c.Datasets.Push(ctx, d.Name, records, opts...)
	if err != nil {
		return err
	}
	d.Dataset = fresh.Dataset
	return nil
}

// Records iterates over this dataset's records.
func (d *Dataset) Records(ctx context.Context, opts ...RecordsOption) iter.Seq2[Trajectory, error] {
	return d.c.Datasets.Records(ctx, d.Name, opts...)
}

// Render previews tokenization of this dataset.
func (d *Dataset) Render(ctx context.Context, o RenderOptions) (*RenderResult, error) {
	return d.c.Datasets.Render(ctx, d.Name, o)
}

type importConfig struct {
	format    string
	connector string
}

// ImportOption configures ImportFile.
type ImportOption func(*importConfig)

// WithFormat forces the file format: jsonl, json or parquet (default auto).
func WithFormat(format string) ImportOption { return func(c *importConfig) { c.format = format } }

// WithConnector forces the trace connector: grad_trajectories, openai_chat, otel, langfuse, ... (default auto).
func WithConnector(connector string) ImportOption {
	return func(c *importConfig) { c.connector = connector }
}

// ImportHandle is a started import. Call Wait to block until it finishes.
type ImportHandle struct {
	c   *Client
	job *ImportJob
	err error
}

// Result returns the job as created (or the error that prevented it).
func (h *ImportHandle) Result() (*ImportJob, error) { return h.job, h.err }

// Wait polls until the import completes; a failed import returns *ImportFailedError.
func (h *ImportHandle) Wait(ctx context.Context, opts ...WaitOption) (*ImportJob, error) {
	if h.err != nil {
		return nil, h.err
	}
	return h.c.Imports.Wait(ctx, h.job.ID, opts...)
}

// ImportFile uploads a JSONL, JSON or Parquet file (grad trajectories or a supported
// trace export) and starts an import job parsed by the trainer worker.
func (d *Dataset) ImportFile(ctx context.Context, path string, opts ...ImportOption) *ImportHandle {
	job, err := d.c.importFile(ctx, d.Name, path, opts)
	return &ImportHandle{c: d.c, job: job, err: err}
}

// ImportHF starts importing a Hugging Face dataset into this dataset.
func (d *Dataset) ImportHF(ctx context.Context, repo string, o HFOptions) *ImportHandle {
	api, err := d.c.api()
	if err != nil {
		return &ImportHandle{c: d.c, err: err}
	}
	req := &generated.CreateImportRequest{Source: o.source(repo)}
	if o.Connector != "" {
		req.Connector = ptr(generated.CreateImportRequestConnector(o.Connector))
	}
	job, err := api.CreateDatasetImport(ctx, d.Name, req)
	return &ImportHandle{c: d.c, job: job, err: err}
}

func (c *Client) importFile(ctx context.Context, dataset, path string, opts []ImportOption) (*ImportJob, error) {
	cfg := &importConfig{}
	for _, opt := range opts {
		opt(cfg)
	}
	api, err := c.api()
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return nil, fmt.Errorf("grad: hashing %s: %w", path, err)
	}
	ticket, err := api.CreateUpload(ctx, &generated.CreateUploadRequest{
		Purpose:   generated.CreateUploadRequestPurposeDatasetImport,
		Filename:  filepath.Base(path),
		SizeBytes: int(size),
		SHA256:    hex.EncodeToString(h.Sum(nil)),
	})
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	if err := c.upload(ctx, ticket, f, size); err != nil {
		return nil, err
	}
	src := generated.ImportSource{Kind: generated.ImportSourceKindUpload, UploadID: &ticket.UploadID}
	if cfg.format != "" {
		src.Format = ptr(generated.ImportSourceFormat(cfg.format))
	}
	req := &generated.CreateImportRequest{Source: src}
	if cfg.connector != "" {
		req.Connector = ptr(generated.CreateImportRequestConnector(cfg.connector))
	}
	return api.CreateDatasetImport(ctx, dataset, req)
}

// upload PUTs a file to an upload ticket URL. Only the ticket's headers are sent:
// the URL is presigned (or signed by the server), so the API key never leaves the API.
func (c *Client) upload(ctx context.Context, ticket *generated.UploadTicket, body io.Reader, size int64) error {
	base, err := url.Parse(c.baseURL + "/")
	if err != nil {
		return err
	}
	ref, err := url.Parse(ticket.URL)
	if err != nil {
		return newError("invalid_upload_url", "upload ticket URL %q is invalid: %v", ticket.URL, err)
	}
	target := base.ResolveReference(ref)
	method := string(ticket.Method)
	if method == "" {
		method = http.MethodPut
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	for k, v := range ticket.Headers {
		req.Header.Set(k, v)
	}
	hc := *c.httpClient
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return &GradError{Code: "aborted", Message: "grad: upload cancelled: " + ctx.Err().Error(), Cause: ctx.Err()}
		}
		return &ConnectionError{GradError: &GradError{Code: "connection_error", Message: fmt.Sprintf("grad: uploading to %s://%s failed: %v", target.Scheme, target.Host, err), Cause: err}}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		redacted := target.Scheme + "://" + target.Host + target.Path
		return generated.NewAPIError(resp.StatusCode, resp.Header, raw, method, redacted, true)
	}
	return nil
}

// ImportsService reads import jobs.
type ImportsService struct{ c *Client }

// Get fetches an import job.
func (s *ImportsService) Get(ctx context.Context, id string) (*ImportJob, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	return api.GetImport(ctx, id)
}

// List iterates over import jobs, newest first.
func (s *ImportsService) List(ctx context.Context) iter.Seq2[*ImportJob, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*ImportJob, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListImports(ctx, &generated.ListImportsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		return pointers(page.Data), page.NextCursor, nil
	})
}

// Wait polls an import job until it completes or fails.
func (s *ImportsService) Wait(ctx context.Context, id string, opts ...WaitOption) (*ImportJob, error) {
	w := newWaitConfig(opts)
	var job *ImportJob
	err := s.c.poll(ctx, w, "import "+id, func(ctx context.Context) (string, bool, error) {
		j, err := s.Get(ctx, id)
		if err != nil {
			return "", false, err
		}
		job = j
		switch j.Status {
		case generated.ImportStatusCompleted:
			return string(j.Status), true, nil
		case generated.ImportStatusFailed:
			msg := deref(j.Error)
			if msg == "" {
				msg = "no error reported"
			}
			return string(j.Status), false, &ImportFailedError{GradError: newError("import_failed", "import %s into %q failed: %s", j.ID, j.Dataset, msg), Job: j}
		}
		return string(j.Status), false, nil
	})
	if err != nil {
		return job, err
	}
	return job, nil
}
