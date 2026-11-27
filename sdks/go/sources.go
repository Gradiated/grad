package grad

import (
	"context"
	"errors"
	"iter"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// SecretRef is a workspace secret's name and metadata, never its value. Pass it as Secret.
type SecretRef struct {
	generated.Secret
}

func (s *SecretRef) secretName() string {
	if s == nil {
		return ""
	}
	return s.Name
}

// SecretName refers to a workspace secret by name.
type SecretName string

func (n SecretName) secretName() string { return string(n) }

// SecretLike is a *SecretRef (from client.Secrets.Get) or a SecretName.
type SecretLike interface{ secretName() string }

var errNoSecretValue = errors.New("grad: a secret value must be a non-empty string")

// SecretsService stores provider keys and Hugging Face tokens. Values are write-only.
type SecretsService struct{ c *Client }

// Set creates or replaces a secret. The value is encrypted at rest and never returned.
func (s *SecretsService) Set(ctx context.Context, name, value string) (*SecretRef, error) {
	if value == "" {
		return nil, errNoSecretValue
	}
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	secret, err := api.SetSecret(ctx, &generated.SetSecretRequest{Name: name, Value: value})
	if err != nil {
		return nil, err
	}
	return &SecretRef{Secret: *secret}, nil
}

// Get returns a reference to pass as Secret (it checks that the secret exists).
func (s *SecretsService) Get(ctx context.Context, name string) (*SecretRef, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	secret, err := api.GetSecret(ctx, name)
	if err != nil {
		return nil, err
	}
	return &SecretRef{Secret: *secret}, nil
}

// List iterates over secret names and metadata, newest first.
func (s *SecretsService) List(ctx context.Context) iter.Seq2[*SecretRef, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*SecretRef, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListSecrets(ctx, &generated.ListSecretsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*SecretRef, len(page.Data))
		for i := range page.Data {
			out[i] = &SecretRef{Secret: page.Data[i]}
		}
		return out, page.NextCursor, nil
	})
}

// Delete deletes a secret (*ConflictError while a source uses it).
func (s *SecretsService) Delete(ctx context.Context, secret SecretLike) error {
	api, err := s.c.api()
	if err != nil {
		return err
	}
	return api.DeleteSecret(ctx, secret.secretName())
}

// SourceProvider is an observability provider a dataset can sync from:
// LangfuseSource, LangSmithSource, BraintrustSource, PostHogSource, PhoenixSource or GradiatedSource.
type SourceProvider interface {
	wire() generated.SourceProvider
}

// ProviderConfig is what every provider but gradiated takes.
type ProviderConfig struct {
	// Host is the provider API host (optional where the provider has one public host).
	Host string
	// Secret is the workspace secret holding the provider key.
	Secret SecretLike
	// Project is required for Braintrust (id or name) and PostHog (numeric id).
	Project string
	// Filters are provider-specific filters passed to the fetcher.
	Filters map[string]any
}

func (p ProviderConfig) wire(kind string) generated.SourceProvider {
	out := generated.SourceProvider{Kind: kind, Host: optString(p.Host), Project: optString(p.Project)}
	if p.Secret != nil {
		out.Secret = optString(p.Secret.secretName())
	}
	if len(p.Filters) > 0 {
		out.Filters = p.Filters
	}
	return out
}

type (
	// LangfuseSource syncs Langfuse traces and scores; the secret is PUBLIC_KEY:SECRET_KEY.
	LangfuseSource ProviderConfig
	// LangSmithSource syncs LangSmith runs and feedback, including corrections.
	LangSmithSource ProviderConfig
	// BraintrustSource syncs Braintrust project logs, scores and expected answers.
	BraintrustSource ProviderConfig
	// PostHogSource syncs PostHog LLM events and survey feedback.
	PostHogSource ProviderConfig
	// PhoenixSource syncs Arize Phoenix spans and annotations (Host is required).
	PhoenixSource ProviderConfig
)

func (p LangfuseSource) wire() generated.SourceProvider  { return ProviderConfig(p).wire("langfuse") }
func (p LangSmithSource) wire() generated.SourceProvider { return ProviderConfig(p).wire("langsmith") }
func (p BraintrustSource) wire() generated.SourceProvider {
	return ProviderConfig(p).wire("braintrust")
}
func (p PostHogSource) wire() generated.SourceProvider { return ProviderConfig(p).wire("posthog") }
func (p PhoenixSource) wire() generated.SourceProvider { return ProviderConfig(p).wire("phoenix") }

// GradiatedSource syncs Gradiated Cloud gateway traces and feedback (Cloud only).
type GradiatedSource struct {
	Models, Tasks, Versions []string
	Filters                 map[string]any
}

func (p GradiatedSource) wire() generated.SourceProvider {
	filters := map[string]any{}
	for k, v := range p.Filters {
		filters[k] = v
	}
	for key, values := range map[string][]string{"models": p.Models, "tasks": p.Tasks, "versions": p.Versions} {
		if len(values) > 0 {
			filters[key] = values
		}
	}
	return ProviderConfig{Filters: filters}.wire("gradiated")
}

// SourceParams configures a new source.
type SourceParams struct {
	Provider SourceProvider
	// Schedule is a five-field UTC cron; empty syncs only on request.
	Schedule string
	// IdempotencyKey makes a retried create return the first source.
	IdempotencyKey string
}

// Source is an observability provider synced into a dataset; each sync adds a dataset version.
type Source struct {
	generated.Source
	c *Client
}

// SyncOption configures a sync.
type SyncOption func(*bool)

// FullSync rebuilds the dataset from the provider as a new version.
func FullSync() SyncOption { return func(full *bool) { *full = true } }

// Sync syncs now (a sync in progress is returned as is). Wait on the handle to block.
func (s *Source) Sync(ctx context.Context, opts ...SyncOption) *ImportHandle {
	return s.c.Sources.Sync(ctx, s.ID, opts...)
}

// Refresh reloads the source.
func (s *Source) Refresh(ctx context.Context) error {
	fresh, err := s.c.Sources.Get(ctx, s.ID)
	if err != nil {
		return err
	}
	s.Source = fresh.Source
	return nil
}

// Remove disconnects the source; the dataset and its versions stay.
func (s *Source) Remove(ctx context.Context) error { return s.c.Sources.Remove(ctx, s.ID) }

// AddSource connects an observability provider to this dataset.
func (d *Dataset) AddSource(ctx context.Context, p SourceParams) (*Source, error) {
	return d.c.Sources.Create(ctx, d, p)
}

// Sources lists the sources syncing into this dataset.
func (d *Dataset) Sources(ctx context.Context) iter.Seq2[*Source, error] {
	return d.c.Sources.List(ctx, d)
}

// SourcesService manages observability sources.
type SourcesService struct{ c *Client }

var errNoProvider = errors.New("grad: SourceParams.Provider is required (for example grad.LangfuseSource{...})")

// Create connects p.Provider to dataset.
func (s *SourcesService) Create(ctx context.Context, dataset DatasetRef, p SourceParams) (*Source, error) {
	if p.Provider == nil {
		return nil, errNoProvider
	}
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	src, err := api.CreateDatasetSource(ctx, dataset.datasetName(),
		&generated.CreateSourceRequest{Provider: p.Provider.wire(), Schedule: optString(p.Schedule)},
		idempotency(p.IdempotencyKey)...)
	if err != nil {
		return nil, err
	}
	return &Source{Source: *src, c: s.c}, nil
}

// Get fetches a source.
func (s *SourcesService) Get(ctx context.Context, id string) (*Source, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	src, err := api.GetSource(ctx, id)
	if err != nil {
		return nil, err
	}
	return &Source{Source: *src, c: s.c}, nil
}

// List iterates over sources, newest first; pass a dataset to keep its sources only.
func (s *SourcesService) List(ctx context.Context, dataset DatasetRef) iter.Seq2[*Source, error] {
	var name *string
	if dataset != nil && dataset.datasetName() != "" {
		name = ptr(dataset.datasetName())
	}
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Source, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListSources(ctx, &generated.ListSourcesParams{Cursor: cursor, Dataset: name})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Source, len(page.Data))
		for i := range page.Data {
			out[i] = &Source{Source: page.Data[i], c: s.c}
		}
		return out, page.NextCursor, nil
	})
}

// Sync queues a sync of source id (or returns the one in progress).
func (s *SourcesService) Sync(ctx context.Context, id string, opts ...SyncOption) *ImportHandle {
	full := false
	for _, opt := range opts {
		opt(&full)
	}
	api, err := s.c.api()
	if err != nil {
		return &ImportHandle{c: s.c, err: err}
	}
	job, err := api.SyncSource(ctx, id, &generated.SyncSourceRequest{Full: &full})
	return &ImportHandle{c: s.c, job: job, err: err}
}

// Remove disconnects a source; its dataset and versions stay.
func (s *SourcesService) Remove(ctx context.Context, id string) error {
	api, err := s.c.api()
	if err != nil {
		return err
	}
	return api.DeleteSource(ctx, id)
}
