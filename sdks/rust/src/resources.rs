//! Resource namespaces: `client.datasets()`, `client.runs()`, ...

use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::download::{self, DownloadOptions, DownloadedArtifact, TempDir, TempFile};
use crate::error::{Error, Result};
use crate::events::{RunEvent, RunEventStream, RunEventsPage};
use crate::models::*;
use crate::sse::{MetricEvent, MetricStream};
use crate::transport::{Body, Deadline, Req};
use crate::usage::{UsageQuery, UsageSummaryQuery};
use crate::util::{self, check_path_param, encode_segment as seg};
use crate::{enc, Client};

/// Polling options for `wait` helpers.
#[derive(Debug, Clone)]
pub struct WaitOptions {
    /// Give up after this long (`None` waits forever).
    pub timeout: Option<Duration>,
    /// First poll interval (default 500 ms); doubles up to `max_interval`.
    pub interval: Duration,
    /// Maximum poll interval (default 5 s).
    pub max_interval: Duration,
    /// Consecutive transient errors tolerated before giving up (default 30).
    pub max_transient_errors: u32,
}

impl Default for WaitOptions {
    fn default() -> Self {
        WaitOptions {
            timeout: Some(Duration::from_secs(24 * 3600)),
            interval: Duration::from_millis(500),
            max_interval: Duration::from_secs(5),
            max_transient_errors: 30,
        }
    }
}

impl WaitOptions {
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }
}

struct Poller {
    opts: WaitOptions,
    start: Instant,
    delay: Duration,
    errors: u32,
}

impl Poller {
    fn new(opts: &WaitOptions) -> Self {
        Poller {
            opts: opts.clone(),
            start: Instant::now(),
            delay: opts.interval,
            errors: 0,
        }
    }

    fn remaining(&self) -> Option<Duration> {
        self.opts
            .timeout
            .map(|t| t.saturating_sub(self.start.elapsed()))
    }

    fn expired(&self) -> bool {
        self.remaining().is_some_and(|r| r.is_zero())
    }

    /// Handle a poll error: Ok(()) to retry later, Err to give up.
    fn on_error(&mut self, e: Error) -> Result<()> {
        if e.is_transient() && self.errors < self.opts.max_transient_errors {
            self.errors += 1;
            Ok(())
        } else {
            Err(e)
        }
    }

    async fn sleep(&mut self) {
        let mut d = self.delay;
        if let Some(r) = self.remaining() {
            d = d.min(r);
        }
        // +/-10% jitter keeps many waiters from polling in lockstep.
        let jitter = 0.9 + util::unit_random() * 0.2;
        tokio::time::sleep(d.mul_f64(jitter)).await;
        self.delay = (self.delay * 2).min(self.opts.max_interval);
    }

    fn timeout_error(&self, what: &str, id: &str, status: &str) -> Error {
        Error::WaitTimeout {
            what: what.into(),
            id: id.into(),
            status: status.into(),
            after: self.start.elapsed(),
        }
    }
}

macro_rules! resource {
    ($name:ident) => {
        #[derive(Clone, Copy)]
        pub struct $name<'a> {
            pub(crate) c: &'a Client,
        }
    };
}

resource!(Models);
resource!(Keys);
resource!(Datasets);
resource!(Imports);
resource!(Runs);
resource!(Checkpoints);
resource!(Artifacts);
resource!(Deployments);
resource!(Evals);
resource!(Secrets);
resource!(UsageLedger);
resource!(Sources);

async fn get<T: DeserializeOwned>(c: &Client, req: Req) -> Result<T> {
    c.t().json(req).await
}

fn body<T: serde::Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(enc)
}

/// Tracks the cursors one listing has followed so a server that repeats a
/// cursor (or hands out cursors with empty pages) cannot make a pager loop.
#[derive(Debug, Default)]
pub struct CursorTrail {
    path: String,
    seen: std::collections::HashSet<String>,
    pages: usize,
}

impl CursorTrail {
    pub fn new(path: impl Into<String>) -> Self {
        CursorTrail {
            path: path.into(),
            ..Default::default()
        }
    }

    /// Record a page that was fetched with `sent` and returned `items` rows and
    /// `next`. Returns the cursor to fetch next, `None` when paging is done
    /// (no cursor, or an empty page), or `Error::PaginationLoop` when `next`
    /// was already followed (or equals the cursor that produced this page).
    pub fn advance(
        &mut self,
        sent: Option<&str>,
        items: usize,
        next: Option<&str>,
    ) -> Result<Option<String>> {
        self.pages += 1;
        if let Some(s) = sent {
            self.seen.insert(s.to_string());
        }
        let next = match next {
            Some(n) if !n.is_empty() => n,
            _ => return Ok(None),
        };
        if self.seen.contains(next) {
            return Err(Error::PaginationLoop {
                path: self.path.clone(),
                cursor: next.to_string(),
            });
        }
        if items == 0 {
            return Ok(None);
        }
        Ok(Some(next.to_string()))
    }

    /// Pages recorded so far.
    pub fn pages(&self) -> usize {
        self.pages
    }

    fn limit_error(&self) -> Error {
        Error::PaginationLimit {
            path: self.path.clone(),
            pages: self.pages,
        }
    }
}

/// Page budget for collect-all helpers (at most 200 rows per page).
const MAX_COLLECT_PAGES: usize = 500;

/// Follow `next_cursor` until exhausted. Stops on an empty page, fails with
/// `PaginationLoop` on a repeated cursor and `PaginationLimit` past
/// `MAX_COLLECT_PAGES` pages, so the result is always bounded.
async fn collect_all<T: DeserializeOwned>(
    c: &Client,
    path: &str,
    page_size: u32,
    extra: Vec<(String, String)>,
) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    let mut trail = CursorTrail::new(path);
    loop {
        if trail.pages() >= MAX_COLLECT_PAGES {
            return Err(trail.limit_error());
        }
        let req = Req::get(path)
            .query(extra.clone())
            .param("limit", page_size)
            .opt_param("cursor", cursor.clone());
        let page: Page<T> = c.t().json(req).await?;
        let n = page.data.len();
        out.extend(page.data);
        match trail.advance(cursor.as_deref(), n, page.next_cursor.as_deref())? {
            Some(next) => cursor = Some(next),
            None => return Ok(out),
        }
    }
}

impl Models<'_> {
    /// Trainable base models (`GET /v1/base-models`).
    pub async fn list(&self) -> Result<Vec<TrainableModel>> {
        let page: Page<TrainableModel> = get(self.c, Req::get("/v1/base-models")).await?;
        Ok(page.data)
    }
}

impl Keys<'_> {
    /// Create a scoped key; the secret is only returned here.
    pub async fn create(&self, name: &str, scopes: &[String]) -> Result<CreatedApiKey> {
        get(
            self.c,
            Req::post("/v1/keys").json(json!({ "name": name, "scopes": scopes })),
        )
        .await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<ApiKey>> {
        get(self.c, Req::get("/v1/keys").query(p.query())).await
    }

    pub async fn list_all(&self) -> Result<Vec<ApiKey>> {
        collect_all(self.c, "/v1/keys", LIST_API_KEYS_LIMIT_MAX, vec![]).await
    }

    pub async fn revoke(&self, id: &str) -> Result<ApiKey> {
        check_path_param("key id", id)?;
        get(
            self.c,
            Req::new(Method::DELETE, format!("/v1/keys/{}", seg(id))),
        )
        .await
    }
}

/// Options for [`Datasets::push_file`].
#[derive(Debug, Clone)]
pub struct PushOptions {
    /// Records per request (default 1000, server max 50000).
    pub batch_records: usize,
    /// Approximate bytes per request (default 8 MiB; the server caps JSON bodies).
    pub batch_bytes: usize,
}

impl Default for PushOptions {
    fn default() -> Self {
        PushOptions {
            batch_records: 1000,
            batch_bytes: 8 * 1024 * 1024,
        }
    }
}

/// Progress of a chunked push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushProgress {
    pub records_sent: u64,
    pub batches_sent: u64,
}

/// Options for [`Datasets::import_file`].
#[derive(Debug, Clone, Default)]
pub struct ImportFileOptions {
    /// `auto` (default), `jsonl`, `json` or `parquet`.
    pub format: Option<String>,
    /// Connector (`auto`, `openai_chat`, `otel`, `langfuse`, ...).
    pub connector: Option<String>,
}

impl Datasets<'_> {
    pub async fn list(&self, p: &ListParams) -> Result<Page<Dataset>> {
        get(self.c, Req::get("/v1/datasets").query(p.query())).await
    }

    pub async fn list_all(&self) -> Result<Vec<Dataset>> {
        collect_all(self.c, "/v1/datasets", LIST_DATASETS_LIMIT_MAX, vec![]).await
    }

    pub async fn get(&self, name: &str) -> Result<Dataset> {
        check_path_param("dataset name", name)?;
        get(self.c, Req::get(format!("/v1/datasets/{}", seg(name)))).await
    }

    pub async fn create(
        &self,
        name: &str,
        metadata: Option<Map<String, Value>>,
    ) -> Result<Dataset> {
        let mut b = json!({ "name": name });
        if let Some(m) = metadata {
            b["metadata"] = Value::Object(m);
        }
        get(self.c, Req::post("/v1/datasets").json(b)).await
    }

    /// Append records as a new dataset version (one request; creates the dataset if needed).
    pub async fn push(&self, name: &str, records: &[Value]) -> Result<Dataset> {
        check_path_param("dataset name", name)?;
        if records.is_empty() {
            return Err(Error::InvalidInput("push needs at least one record".into()));
        }
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/records", seg(name)))
                .json(json!({ "records": records })),
        )
        .await
    }

    /// Stream a JSONL file and push it in batches (each batch appends a version).
    /// Lines are validated as JSON objects before anything is sent.
    pub async fn push_file(
        &self,
        name: &str,
        path: &Path,
        opts: &PushOptions,
        mut on_progress: impl FnMut(PushProgress),
    ) -> Result<Dataset> {
        check_path_param("dataset name", name)?;
        let batch_records = opts.batch_records.clamp(1, 50_000);
        // First pass: validate every line so a bad line 40,000 never leaves a half-pushed dataset.
        let mut total = 0u64;
        for_each_jsonl(path, |_, _| {
            total += 1;
            Ok(())
        })?;
        if total == 0 {
            return Err(Error::InvalidInput(format!(
                "{} has no records",
                path.display()
            )));
        }
        let mut batch: Vec<Value> = Vec::new();
        let mut batch_bytes = 0usize;
        let mut progress = PushProgress {
            records_sent: 0,
            batches_sent: 0,
        };
        let mut last: Option<Dataset> = None;
        // Second pass: read lazily and send batch by batch (bounded memory).
        let file = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
        let reader = std::io::BufReader::new(file);
        let mut lines = reader.lines();
        loop {
            let line = lines.next().transpose().map_err(|e| Error::io(path, e))?;
            let at_end = line.is_none();
            if let Some(line) = line {
                let t = line.trim();
                if !t.is_empty() {
                    let v: Value =
                        serde_json::from_str(t).map_err(|e| Error::InvalidInput(e.to_string()))?;
                    batch_bytes += t.len();
                    batch.push(v);
                }
            }
            let full = batch.len() >= batch_records || batch_bytes >= opts.batch_bytes;
            if !batch.is_empty() && (full || at_end) {
                let n = batch.len() as u64;
                last = Some(self.push(name, &batch).await?);
                batch.clear();
                batch_bytes = 0;
                progress.records_sent += n;
                progress.batches_sent += 1;
                on_progress(progress);
            }
            if at_end {
                break;
            }
        }
        last.ok_or_else(|| Error::InvalidInput(format!("{} has no records", path.display())))
    }

    pub async fn records(
        &self,
        name: &str,
        version: Option<u64>,
        p: &ListParams,
    ) -> Result<DatasetRecordsPage> {
        check_path_param("dataset name", name)?;
        get(
            self.c,
            Req::get(format!("/v1/datasets/{}/records", seg(name)))
                .opt_param("version", version)
                .query(p.query()),
        )
        .await
    }

    /// Preview chat-template rendering and loss masks.
    pub async fn render(
        &self,
        name: &str,
        req: &RenderDatasetRequest,
    ) -> Result<RenderDatasetResponse> {
        check_path_param("dataset name", name)?;
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/render", seg(name))).json(body(req)?),
        )
        .await
    }

    /// Import a built-in benchmark (`gsm8k`, `mmlu`, `mmlu_pro`, `arc_challenge`) at a
    /// pinned revision; evals on the dataset without a rubric use its answer check.
    pub async fn import_benchmark(
        &self,
        name: &str,
        benchmark: &str,
        limit: Option<i64>,
    ) -> Result<ImportJob> {
        self.create_import(
            name,
            &CreateImportRequest {
                source: ImportSource {
                    kind: ImportSourceKind::Benchmark,
                    benchmark: Some(ImportSourceBenchmark::from(benchmark)),
                    limit,
                    ..Default::default()
                },
                connector: Some(CreateImportRequestConnector::Auto),
            },
        )
        .await
    }

    /// Score the records' own answers with a rubric (`POST /v1/datasets/{name}/score`):
    /// an eval in mode `score`, billed like one. Wait with [`Datasets::wait_scored`].
    pub async fn score(
        &self,
        name: &str,
        req: &ScoreDatasetRequest,
        idempotency_key: Option<&str>,
    ) -> Result<EvalRun> {
        check_path_param("dataset name", name)?;
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/score", seg(name)))
                .key(idempotency_key)
                .json(body(req)?),
        )
        .await
    }

    /// Wait for a scoring job and return the dataset whose version
    /// `scored_dataset_version` carries the scores.
    pub async fn wait_scored(
        &self,
        id: &str,
        opts: &WaitOptions,
        on_progress: impl FnMut(&EvalRun),
    ) -> Result<(EvalRun, Dataset)> {
        let ev = Evals { c: self.c }.wait(id, opts, on_progress).await?;
        let dataset = self.get(&ev.task_source.dataset).await?;
        Ok((ev, dataset))
    }

    /// Save a filtered view (`POST /v1/datasets/{name}/filter`); field filters
    /// run on the server at no cost, and the same filter returns the same view.
    pub async fn filter(&self, name: &str, req: &FilterDatasetRequest) -> Result<Dataset> {
        check_path_param("dataset name", name)?;
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/filter", seg(name))).json(body(req)?),
        )
        .await
    }

    /// Run `keep` over the records of `version` (default: current) here and
    /// save the matching ids as a view named `view` (default: hashed).
    pub async fn filter_with(
        &self,
        name: &str,
        version: Option<u64>,
        view: Option<&str>,
        mut keep: impl FnMut(&DatasetRecord) -> bool,
    ) -> Result<Dataset> {
        let version = match version {
            Some(v) => v,
            None => self.get(name).await?.version as u64,
        };
        let mut ids = Vec::new();
        let mut trail = CursorTrail::new(format!("GET /v1/datasets/{name}/records"));
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .records(
                    name,
                    Some(version),
                    &ListParams {
                        limit: Some(1000),
                        cursor: cursor.clone(),
                    },
                )
                .await?;
            for rec in &page.data {
                if let Some(id) = rec.id.as_ref().filter(|_| keep(rec)) {
                    ids.push(id.clone());
                }
            }
            cursor = trail.advance(
                cursor.as_deref(),
                page.data.len(),
                page.next_cursor.as_deref(),
            )?;
            if cursor.is_none() {
                break;
            }
            if trail.pages() > MAX_COLLECT_PAGES {
                return Err(trail.limit_error());
            }
        }
        self.filter(
            name,
            &FilterDatasetRequest {
                ids: Some(ids),
                version: Some(version as i64),
                name: view.map(str::to_string),
                ..Default::default()
            },
        )
        .await
    }

    /// Start an import job (`POST /v1/datasets/{name}/imports`).
    pub async fn create_import(&self, name: &str, req: &CreateImportRequest) -> Result<ImportJob> {
        check_path_param("dataset name", name)?;
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/imports", seg(name))).json(body(req)?),
        )
        .await
    }

    /// Upload a local file (streamed, never buffered) and start an import job.
    pub async fn import_file(
        &self,
        name: &str,
        path: &Path,
        opts: &ImportFileOptions,
    ) -> Result<ImportJob> {
        let ticket = self.c.upload_file(path).await?;
        self.create_import(
            name,
            &CreateImportRequest {
                source: ImportSource {
                    kind: ImportSourceKind::Upload,
                    upload_id: Some(ticket.upload_id),
                    format: opts.format.as_deref().map(ImportSourceFormat::from),
                    ..Default::default()
                },
                connector: opts
                    .connector
                    .as_deref()
                    .map(CreateImportRequestConnector::from),
            },
        )
        .await
    }

    /// Import a Hugging Face dataset (pulled by the trainer worker).
    pub async fn import_hf(
        &self,
        name: &str,
        source: ImportSource,
        connector: Option<String>,
    ) -> Result<ImportJob> {
        let connector = connector.as_deref().map(CreateImportRequestConnector::from);
        self.create_import(name, &CreateImportRequest { source, connector })
            .await
    }

    /// [`import_hf`](Self::import_hf) for a gated or private dataset: the worker
    /// gets the token from the workspace secret `secret`, never from this process.
    pub async fn import_hf_with_secret(
        &self,
        name: &str,
        source: ImportSource,
        connector: Option<String>,
        secret: impl SecretName,
    ) -> Result<ImportJob> {
        check_path_param("dataset name", name)?;
        let connector = connector.as_deref().map(CreateImportRequestConnector::from);
        let mut req = body(&CreateImportRequest { source, connector })?;
        req["source"]["secret"] = Value::String(secret.secret_name());
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/imports", seg(name))).json(req),
        )
        .await
    }

    /// Connect an observability provider to dataset `name` (see [`Sources::create`]).
    pub async fn add_source(
        &self,
        name: &str,
        provider: &SourceProvider,
        schedule: Option<&str>,
    ) -> Result<Source> {
        self.c
            .sources()
            .create(name, provider, schedule, None)
            .await
    }

    /// The sources syncing into dataset `name`.
    pub async fn sources(&self, name: &str) -> Result<Vec<Source>> {
        self.c.sources().list_all(Some(name)).await
    }
}

impl UsageLedger<'_> {
    /// Billed rows matching `q`, newest first: one per billed increment of a run or eval attempt.
    pub async fn list(&self, q: &UsageQuery) -> Result<Page<UsageRecord>> {
        get(self.c, Req::get("/v1/usage").query(q.query())).await
    }

    /// Every billed row matching `q`'s filters (its `limit` and `cursor` are ignored).
    pub async fn list_all(&self, q: &UsageQuery) -> Result<Vec<UsageRecord>> {
        collect_all(self.c, "/v1/usage", LIST_USAGE_LIMIT_MAX, q.filters()).await
    }

    /// Total cost and tokens, by kind, the top runs and evals, and `group_by`
    /// groups over a period (default: the current UTC month).
    pub async fn summary(&self, q: &UsageSummaryQuery) -> Result<UsageSummary> {
        get(self.c, Req::get("/v1/usage/summary").query(q.query())).await
    }
}

impl Secrets<'_> {
    /// Create or replace a secret. The value is encrypted at rest and never returned.
    /// The server sends it only to the public provider hosts; see [`Self::set_with_hosts`].
    pub async fn set(&self, name: &str, value: &str) -> Result<SecretRef> {
        self.put(name, value, None).await
    }

    /// [`Self::set`] for a self-hosted tool: `allowed_hosts` are the only hosts the
    /// server sends the value to (a source's host, huggingface.co for HF imports, a
    /// logger's host).
    pub async fn set_with_hosts(
        &self,
        name: &str,
        value: &str,
        allowed_hosts: &[&str],
    ) -> Result<SecretRef> {
        self.put(name, value, Some(allowed_hosts)).await
    }

    async fn put(&self, name: &str, value: &str, hosts: Option<&[&str]>) -> Result<SecretRef> {
        check_path_param("secret name", name)?;
        if value.is_empty() {
            return Err(Error::InvalidInput(
                "a secret value must not be empty".into(),
            ));
        }
        let mut body = json!({ "name": name, "value": value });
        if let Some(hosts) = hosts {
            body["allowed_hosts"] = json!(hosts);
        }
        get(self.c, Req::post("/v1/secrets").json(body)).await
    }

    /// A reference to pass as a secret (checks that it exists; no value).
    pub async fn get(&self, name: &str) -> Result<SecretRef> {
        check_path_param("secret name", name)?;
        get(self.c, Req::get(format!("/v1/secrets/{}", seg(name)))).await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<SecretRef>> {
        get(self.c, Req::get("/v1/secrets").query(p.query())).await
    }

    pub async fn list_all(&self) -> Result<Vec<SecretRef>> {
        collect_all(self.c, "/v1/secrets", LIST_SECRETS_LIMIT_MAX, vec![]).await
    }

    /// Delete a secret ([`Error::Conflict`] while a source uses it).
    pub async fn delete(&self, secret: impl SecretName) -> Result<()> {
        let name = secret.secret_name();
        check_path_param("secret name", &name)?;
        let req = Req::new(Method::DELETE, format!("/v1/secrets/{}", seg(&name)));
        self.c.t().send(&req).await.map(drop)
    }
}

impl Sources<'_> {
    /// Connect `provider` to `dataset`. A source feeds exactly one dataset; a
    /// dataset can have several sources, and deleting it deletes them.
    /// `schedule` is a five-field UTC cron (at most once a minute); without one
    /// the source syncs only on request.
    pub async fn create(
        &self,
        dataset: &str,
        provider: &SourceProvider,
        schedule: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<Source> {
        check_path_param("dataset name", dataset)?;
        let mut b = json!({ "provider": body(provider)? });
        if let Some(s) = schedule {
            b["schedule"] = Value::String(s.to_string());
        }
        get(
            self.c,
            Req::post(format!("/v1/datasets/{}/sources", seg(dataset)))
                .key(idempotency_key)
                .json(b),
        )
        .await
    }

    pub async fn get(&self, id: &str) -> Result<Source> {
        check_path_param("source id", id)?;
        get(self.c, Req::get(format!("/v1/sources/{}", seg(id)))).await
    }

    /// One page of sources, optionally for one dataset.
    pub async fn list(&self, dataset: Option<&str>, p: &ListParams) -> Result<Page<Source>> {
        get(
            self.c,
            Req::get("/v1/sources")
                .query(p.query())
                .opt_param("dataset", dataset),
        )
        .await
    }

    pub async fn list_all(&self, dataset: Option<&str>) -> Result<Vec<Source>> {
        let extra = dataset
            .map(|d| vec![("dataset".to_string(), d.to_string())])
            .unwrap_or_default();
        collect_all(self.c, "/v1/sources", LIST_SOURCES_LIMIT_MAX, extra).await
    }

    /// Queue a sync, or get the one already in progress (a `full` request then
    /// runs right after it); wait on it with [`Imports::wait`]. `full` rebuilds
    /// the dataset from the provider as a new version. A source starts at most
    /// one sync a minute: within a minute of the last start this returns that
    /// sync. Syncing a paused source resumes it.
    pub async fn sync(&self, id: &str, full: bool) -> Result<ImportJob> {
        check_path_param("source id", id)?;
        get(
            self.c,
            Req::post(format!("/v1/sources/{}/sync", seg(id))).json(json!({ "full": full })),
        )
        .await
    }

    /// Disconnect a source; its dataset and versions stay.
    pub async fn remove(&self, id: &str) -> Result<()> {
        check_path_param("source id", id)?;
        let req = Req::new(Method::DELETE, format!("/v1/sources/{}", seg(id)));
        self.c.t().send(&req).await.map(drop)
    }
}

/// Call `f(line_number, value)` for every non-empty JSONL line; errors name the line.
pub fn for_each_jsonl(path: &Path, mut f: impl FnMut(usize, Value) -> Result<()>) -> Result<()> {
    let file = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let reader = std::io::BufReader::new(file);
    for (idx, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| Error::io(path, e))?;
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(t).map_err(|e| {
            Error::InvalidInput(format!(
                "{} line {}: invalid JSON: {}",
                path.display(),
                idx + 1,
                e
            ))
        })?;
        if !v.is_object() {
            return Err(Error::InvalidInput(format!(
                "{} line {}: each record must be a JSON object",
                path.display(),
                idx + 1
            )));
        }
        f(idx + 1, v)?;
    }
    Ok(())
}

impl Client {
    /// Hash a file, create an upload ticket and stream the bytes to it.
    pub async fn upload_file(&self, path: &Path) -> Result<UploadTicket> {
        let meta = std::fs::metadata(path).map_err(|e| Error::io(path, e))?;
        if !meta.is_file() {
            return Err(Error::InvalidInput(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        if meta.len() == 0 {
            return Err(Error::InvalidInput(format!("{} is empty", path.display())));
        }
        let p = path.to_path_buf();
        let sha = tokio::task::spawn_blocking(move || sha256_file(&p))
            .await
            .map_err(|e| Error::InvalidInput(format!("hashing failed: {}", e)))??;
        let filename = path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload".into());
        let ticket: UploadTicket = self
            .t()
            .json(Req::post("/v1/uploads").json(json!({
                "purpose": "dataset_import",
                "filename": filename,
                "size_bytes": meta.len(),
                "sha256": sha,
            })))
            .await?;
        let absolute = ticket.url.starts_with("http://") || ticket.url.starts_with("https://");
        let mut req = Req::new(Method::PUT, ticket.url.clone());
        req.absolute = absolute;
        if !absolute && !ticket.url.starts_with('/') {
            req.path = format!("/{}", ticket.url);
        }
        // The upload URL carries its own signature; never send the bearer token to it.
        req.auth = false;
        req.accept = None;
        req.deadline = Deadline::Streaming;
        req.body = Body::File {
            path: path.to_path_buf(),
            len: meta.len(),
        };
        for (k, v) in &ticket.headers {
            req.headers.push((k.to_ascii_lowercase(), v.clone()));
        }
        if !req.headers.iter().any(|(k, _)| k == "content-type") {
            req.headers
                .push(("content-type".into(), "application/octet-stream".into()));
        }
        self.t().send(&req).await?;
        Ok(ticket)
    }
}

/// SHA-256 of a file, streamed.
pub fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| Error::io(path, e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

impl Imports<'_> {
    pub async fn get(&self, id: &str) -> Result<ImportJob> {
        check_path_param("import id", id)?;
        get(self.c, Req::get(format!("/v1/imports/{}", seg(id)))).await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<ImportJob>> {
        get(self.c, Req::get("/v1/imports").query(p.query())).await
    }

    /// Poll until the job completes; a failed job is [`Error::ImportFailed`].
    pub async fn wait(&self, id: &str, opts: &WaitOptions) -> Result<ImportJob> {
        let mut poll = Poller::new(opts);
        loop {
            match self.get(id).await {
                Ok(job) => match job.status {
                    ImportStatus::Completed => return Ok(job),
                    ImportStatus::Failed => return Err(Error::ImportFailed(Box::new(job))),
                    _ => {
                        if poll.expired() {
                            return Err(poll.timeout_error("import", id, job.status.as_str()));
                        }
                    }
                },
                Err(e) => {
                    poll.on_error(e)?;
                    if poll.expired() {
                        return Err(poll.timeout_error("import", id, "unknown"));
                    }
                }
            }
            poll.sleep().await;
        }
    }
}

fn finish_run(run: Run) -> Result<Run> {
    if run.status == RunStatus::Completed {
        Ok(run)
    } else {
        Err(Error::RunFailed(Box::new(run)))
    }
}

impl Runs<'_> {
    /// Dry-run a recipe at zero cost.
    pub async fn plan(&self, req: &PlanRunRequest) -> Result<PlanRunResponse> {
        get(self.c, Req::post("/v1/runs/plan").json(body(req)?)).await
    }

    /// Create and enqueue a run. Pass your own `idempotency_key` to retry the
    /// call (even from another process) without starting a second run. The
    /// returned run's `warnings` holds the plan's warnings, such as another
    /// queued or running run with the same name (names aren't unique).
    pub async fn create(&self, req: &PlanRunRequest, idempotency_key: Option<&str>) -> Result<Run> {
        get(
            self.c,
            Req::post("/v1/runs").key(idempotency_key).json(body(req)?),
        )
        .await
    }

    pub async fn get(&self, id: &str) -> Result<Run> {
        check_path_param("run id", id)?;
        get(self.c, Req::get(format!("/v1/runs/{}", seg(id)))).await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<Run>> {
        get(self.c, Req::get("/v1/runs").query(p.query())).await
    }

    pub async fn list_all(&self) -> Result<Vec<Run>> {
        collect_all(self.c, "/v1/runs", LIST_RUNS_LIMIT_MAX, vec![]).await
    }

    /// Find the newest run with this `name` (runs are addressed by id on the wire).
    pub async fn find_by_name(&self, name: &str) -> Result<Option<Run>> {
        let mut cursor: Option<String> = None;
        let mut trail = CursorTrail::new("/v1/runs");
        loop {
            if trail.pages() >= MAX_COLLECT_PAGES {
                return Err(trail.limit_error());
            }
            let page = self
                .list(&ListParams {
                    limit: Some(LIST_RUNS_LIMIT_MAX),
                    cursor: cursor.clone(),
                })
                .await?;
            let n = page.data.len();
            if let Some(r) = page.data.into_iter().find(|r| r.name == name) {
                return Ok(Some(r));
            }
            match trail.advance(cursor.as_deref(), n, page.next_cursor.as_deref())? {
                Some(next) => cursor = Some(next),
                None => return Ok(None),
            }
        }
    }

    pub async fn cancel(&self, id: &str) -> Result<Run> {
        check_path_param("run id", id)?;
        get(self.c, Req::post(format!("/v1/runs/{}/cancel", seg(id)))).await
    }

    /// Resume from the latest checkpoint, optionally with a raised cost cap.
    pub async fn resume(&self, id: &str, max_cost_usd: Option<f64>) -> Result<Run> {
        check_path_param("run id", id)?;
        let b = match max_cost_usd {
            Some(c) => json!({ "max_cost_usd": c }),
            None => json!({}),
        };
        get(
            self.c,
            Req::post(format!("/v1/runs/{}/resume", seg(id))).json(b),
        )
        .await
    }

    pub async fn metrics(&self, id: &str, q: &MetricsQuery) -> Result<MetricsPage> {
        check_path_param("run id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/runs/{}/metrics", seg(id)))
                .opt_param("cursor", q.cursor.clone())
                .opt_param("after_step", q.after_step)
                .opt_param("limit", q.limit),
        )
        .await
    }

    pub async fn checkpoints(&self, id: &str, p: &ListParams) -> Result<Page<Checkpoint>> {
        check_path_param("run id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/runs/{}/checkpoints", seg(id))).query(p.query()),
        )
        .await
    }

    /// The run's lifecycle events (phase, metric, checkpoint, attempt, warning,
    /// log, completed). With `follow` they stream live over SSE, reconnecting
    /// with `Last-Event-ID` (never repeating an event) until `completed`;
    /// without, the stream pages the events recorded so far.
    ///
    /// ```no_run
    /// # async fn f(c: &grad::Client) -> grad::Result<()> {
    /// let mut events = c.runs().events("run_123", true);
    /// while let Some(ev) = events.next().await {
    ///     match ev? {
    ///         grad::RunEvent::Phase(p) => println!("{}", p.phase.as_str()),
    ///         grad::RunEvent::Attempt(a) => println!("{}", a.message),
    ///         _ => {}
    ///     }
    /// }
    /// # Ok(()) }
    /// ```
    pub fn events(&self, id: &str, follow: bool) -> RunEventStream {
        RunEventStream::new(self.c.t().clone(), id.to_string(), follow)
    }

    /// One JSON page of the run's events.
    pub async fn events_page(
        &self,
        id: &str,
        cursor: Option<String>,
        limit: Option<i64>,
    ) -> Result<RunEventsPage> {
        check_path_param("run id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/runs/{}/events", seg(id)))
                .opt_param("cursor", cursor)
                .opt_param("limit", limit),
        )
        .await
    }

    /// Wait for a run while calling `on_event` with every lifecycle event
    /// (follows the event stream; the timeout in `opts` applies).
    /// `completed` returns the run; other terminal statuses return
    /// [`Error::RunFailed`].
    pub async fn wait_with_events(
        &self,
        id: &str,
        opts: &WaitOptions,
        mut on_event: impl FnMut(&RunEvent),
    ) -> Result<Run> {
        check_path_param("run id", id)?;
        let poll = Poller::new(opts);
        let mut stream = self.events(id, true);
        loop {
            let next = match poll.remaining() {
                Some(r) => match tokio::time::timeout(r, stream.next()).await {
                    Ok(n) => n,
                    Err(_) => {
                        let status = self.get(id).await.map(|r| r.status.as_str().to_string());
                        return Err(poll.timeout_error(
                            "run",
                            id,
                            &status.unwrap_or_else(|_| "unknown".into()),
                        ));
                    }
                },
                None => stream.next().await,
            };
            match next {
                Some(Ok(ev)) => {
                    on_event(&ev);
                    if let RunEvent::Completed(done) = ev {
                        return finish_run(done.run);
                    }
                }
                Some(Err(e)) => return Err(e),
                None => return finish_run(self.get(id).await?),
            }
        }
    }

    /// Live SSE metrics, resuming after `last_event_id` (a metric `seq`).
    pub fn stream_metrics(&self, id: &str, last_event_id: Option<String>) -> MetricStream {
        MetricStream::new(self.c.t().clone(), id.to_string(), last_event_id)
    }

    /// Poll until terminal. `completed` returns the run; `failed`, `cancelled`
    /// `stopped_budget` and `stopped_balance` return [`Error::RunFailed`] carrying the run.
    pub async fn wait(&self, id: &str, opts: &WaitOptions) -> Result<Run> {
        let mut poll = Poller::new(opts);
        loop {
            match self.get(id).await {
                Ok(run) if run.status.is_terminal() => return finish_run(run),
                Ok(run) => {
                    if poll.expired() {
                        return Err(poll.timeout_error("run", id, run.status.as_str()));
                    }
                }
                Err(e) => {
                    poll.on_error(e)?;
                    if poll.expired() {
                        return Err(poll.timeout_error("run", id, "unknown"));
                    }
                }
            }
            poll.sleep().await;
        }
    }

    /// Wait for a run while calling `on_metric` for every new metric point.
    /// Uses the SSE stream and falls back to polling metric pages when the
    /// stream is unavailable (for example behind a buffering proxy).
    pub async fn wait_with_metrics(
        &self,
        id: &str,
        opts: &WaitOptions,
        mut on_metric: impl FnMut(&MetricPoint),
    ) -> Result<Run> {
        check_path_param("run id", id)?;
        let poll = Poller::new(opts);
        let mut last_seq: i64 = 0;
        let mut stream = self.stream_metrics(id, None);
        loop {
            let next = match poll.remaining() {
                Some(r) => match tokio::time::timeout(r, stream.next()).await {
                    Ok(n) => n,
                    Err(_) => {
                        let status = self.get(id).await.map(|r| r.status.as_str().to_string());
                        return Err(poll.timeout_error(
                            "run",
                            id,
                            &status.unwrap_or_else(|_| "unknown".into()),
                        ));
                    }
                },
                None => stream.next().await,
            };
            match next {
                Some(Ok(MetricEvent::Metric(p))) => {
                    if p.seq > last_seq {
                        last_seq = p.seq;
                        on_metric(&p);
                    }
                }
                Some(Ok(MetricEvent::Finished(run))) => return finish_run(*run),
                Some(Err(e)) => match e {
                    Error::Authentication(_) | Error::PermissionDenied(_) | Error::NotFound(_) => {
                        return Err(e)
                    }
                    _ => break,
                },
                None => break,
            }
        }
        // Polling fallback.
        let mut poll = poll;
        let mut cursor: Option<String> = None;
        loop {
            match self
                .metrics(
                    id,
                    &MetricsQuery {
                        cursor: cursor.clone(),
                        after_step: None,
                        limit: Some(LIST_RUN_METRICS_LIMIT_MAX),
                    },
                )
                .await
            {
                Ok(page) => {
                    for p in &page.data {
                        if p.seq > last_seq {
                            last_seq = p.seq;
                            on_metric(p);
                        }
                    }
                    // tail_cursor stays put while no new points arrive, but a
                    // non-empty page must advance it.
                    let tail = page.tail_cursor.as_str();
                    if !tail.is_empty() {
                        if !page.data.is_empty() && cursor.as_deref() == Some(tail) {
                            return Err(Error::PaginationLoop {
                                path: format!("/v1/runs/{}/metrics", id),
                                cursor: tail.to_string(),
                            });
                        }
                        cursor = Some(tail.to_string());
                    }
                    if page.status.is_terminal() {
                        let run = self.get(id).await?;
                        if run.status.is_terminal() {
                            return finish_run(run);
                        }
                    }
                    if poll.expired() {
                        return Err(poll.timeout_error("run", id, page.status.as_str()));
                    }
                }
                Err(e) => {
                    poll.on_error(e)?;
                    if poll.expired() {
                        return Err(poll.timeout_error("run", id, "unknown"));
                    }
                }
            }
            poll.sleep().await;
        }
    }
}

impl Checkpoints<'_> {
    /// Copy a checkpoint into a new immutable artifact.
    pub async fn promote(&self, id: &str, name: Option<&str>) -> Result<Artifact> {
        check_path_param("checkpoint id", id)?;
        let b = match name {
            Some(n) => json!({ "name": n }),
            None => json!({}),
        };
        get(
            self.c,
            Req::post(format!("/v1/checkpoints/{}/promote", seg(id))).json(b),
        )
        .await
    }
}

impl Artifacts<'_> {
    pub async fn list(&self, name: Option<&str>, p: &ListParams) -> Result<Page<Artifact>> {
        get(
            self.c,
            Req::get("/v1/artifacts")
                .query(p.query())
                .opt_param("name", name.map(str::to_string)),
        )
        .await
    }

    /// Get by id, `name@version` or `name@latest`.
    pub async fn get(&self, reference: &str) -> Result<Artifact> {
        check_path_param("artifact reference", reference)?;
        get(
            self.c,
            Req::get(format!("/v1/artifacts/{}", seg(reference))),
        )
        .await
    }

    /// Download, verify and extract (or keep) an artifact bundle.
    pub async fn download(
        &self,
        reference: &str,
        opts: &DownloadOptions,
    ) -> Result<DownloadedArtifact> {
        check_path_param("artifact reference", reference)?;
        if opts.extract_to.is_none() && opts.archive_to.is_none() {
            return Err(Error::InvalidInput(
                "choose an output directory or an archive path".into(),
            ));
        }
        if let Some(dir) = &opts.extract_to {
            if dir.exists() && !opts.overwrite {
                let non_empty = !dir.is_dir()
                    || std::fs::read_dir(dir)
                        .map_err(|e| Error::io(dir, e))?
                        .next()
                        .is_some();
                if non_empty {
                    return Err(Error::InvalidInput(format!(
                        "{} already exists and is not an empty directory; choose a new --output directory or pass --force",
                        dir.display()
                    )));
                }
            }
        }
        if let Some(a) = &opts.archive_to {
            if a.exists() && !opts.overwrite {
                return Err(Error::InvalidInput(format!(
                    "{} already exists; pass --force to replace it",
                    a.display()
                )));
            }
        }
        let tmp_parent: PathBuf = opts
            .archive_to
            .as_deref()
            .or(opts.extract_to.as_deref())
            .map(download::parent_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let mut attempt = 0;
        let (tmp, sha, size) = loop {
            match self.fetch_bundle(reference, &tmp_parent).await {
                Ok(x) => break x,
                Err(e) if e.is_transient() && attempt < self.c.t().max_retries => {
                    tokio::time::sleep(util::backoff(
                        attempt,
                        self.c.t().retry_base,
                        Duration::from_secs(8),
                    ))
                    .await;
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        };
        let mut out = DownloadedArtifact {
            reference: reference.to_string(),
            sha256: sha,
            size_bytes: size,
            directory: None,
            archive: None,
            files: Default::default(),
            manifest: Map::new(),
        };
        if let Some(dest) = &opts.extract_to {
            let dest = dest.clone();
            let archive = tmp.path.clone();
            let limits = opts.limits;
            let overwrite = opts.overwrite;
            let (manifest, files) = tokio::task::spawn_blocking(move || -> Result<_> {
                let mut staging = TempDir::new_in(&download::parent_dir(&dest), "grad-extract")?;
                let res = download::extract_bundle(&archive, &staging.path, limits)?;
                download::install_dir(&staging.path, &dest, overwrite)?;
                staging.disarm();
                Ok(res)
            })
            .await
            .map_err(|e| Error::InvalidInput(format!("extraction failed: {}", e)))??;
            out.manifest = manifest;
            out.files = files;
            out.directory = Some(opts.extract_to.clone().unwrap());
        }
        if let Some(a) = &opts.archive_to {
            tmp.persist(a, opts.overwrite)?;
            out.archive = Some(a.clone());
        }
        Ok(out)
    }

    async fn fetch_bundle(&self, reference: &str, dir: &Path) -> Result<(TempFile, String, u64)> {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let mut req = Req::get(format!("/v1/artifacts/{}/download", seg(reference)));
        req.accept = Some("application/octet-stream");
        req.deadline = Deadline::Streaming;
        let mut resp = self.c.t().send(&req).await?;
        let url = resp.url().to_string();
        let expected = resp
            .headers()
            .get("x-artifact-sha256")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| util::is_sha256_hex(s))
            .ok_or_else(|| Error::Decode {
                method: "GET".into(),
                url: url.clone(),
                message: "the response has no valid X-Artifact-Sha256 header; refusing an unverifiable download".into(),
            })?;
        let expected_len = resp.content_length();
        let mut tmp = TempFile::new_in(dir, "grad-download")?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        loop {
            let chunk = resp.chunk().await.map_err(|e| {
                if e.is_timeout() {
                    Error::Timeout {
                        method: "GET".into(),
                        url: url.clone(),
                        after: None,
                    }
                } else {
                    Error::Connection {
                        method: "GET".into(),
                        url: url.clone(),
                        cause: format!("download interrupted after {} bytes: {}", size, e),
                    }
                }
            })?;
            let Some(chunk) = chunk else { break };
            hasher.update(&chunk);
            size += chunk.len() as u64;
            tmp.file
                .as_mut()
                .expect("open")
                .write_all(&chunk)
                .map_err(|e| Error::io(&tmp.path, e))?;
        }
        if let Some(n) = expected_len {
            if n != size {
                return Err(Error::Checksum {
                    what: format!("artifact {} size", reference),
                    expected: format!("{} bytes", n),
                    actual: format!("{} bytes", size),
                });
            }
        }
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            return Err(Error::Checksum {
                what: format!("artifact {}", reference),
                expected,
                actual,
            });
        }
        if let Some(f) = tmp.file.as_mut() {
            f.sync_all().map_err(|e| Error::io(&tmp.path, e))?;
        }
        Ok((tmp, actual, size))
    }
}

impl Deployments<'_> {
    /// Deploy or update an artifact under a stable model name.
    pub async fn create(
        &self,
        req: &DeployArtifactRequest,
        idempotency_key: Option<&str>,
    ) -> Result<Deployment> {
        get(
            self.c,
            Req::post("/v1/deployments")
                .key(idempotency_key)
                .json(body(req)?),
        )
        .await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<Deployment>> {
        get(self.c, Req::get("/v1/deployments").query(p.query())).await
    }

    pub async fn get(&self, name: &str) -> Result<DeploymentStatus> {
        check_path_param("deployment name", name)?;
        get(self.c, Req::get(format!("/v1/deployments/{}", seg(name)))).await
    }

    /// Roll back to the previous artifact.
    pub async fn rollback(&self, name: &str) -> Result<Deployment> {
        check_path_param("deployment name", name)?;
        get(
            self.c,
            Req::post(format!("/v1/deployments/{}/rollback", seg(name))),
        )
        .await
    }
}

impl Evals<'_> {
    /// Estimate tasks, model and judge calls and cost at zero cost.
    pub async fn plan(&self, req: &PlanEvalRequest) -> Result<PlanEvalResponse> {
        get(self.c, Req::post("/v1/evals/plan").json(body(req)?)).await
    }

    /// Queue an eval (billed; `total_cost_usd` on the result).
    pub async fn create(
        &self,
        req: &PlanEvalRequest,
        idempotency_key: Option<&str>,
    ) -> Result<EvalRun> {
        get(
            self.c,
            Req::post("/v1/evals").key(idempotency_key).json(body(req)?),
        )
        .await
    }

    pub async fn get(&self, id: &str) -> Result<EvalRun> {
        check_path_param("eval id", id)?;
        get(self.c, Req::get(format!("/v1/evals/{}", seg(id)))).await
    }

    pub async fn list(&self, p: &ListParams) -> Result<Page<EvalRun>> {
        get(self.c, Req::get("/v1/evals").query(p.query())).await
    }

    /// Every eval, newest first.
    pub async fn list_all(&self) -> Result<Vec<EvalRun>> {
        collect_all(self.c, "/v1/evals", LIST_EVALS_LIMIT_MAX, vec![]).await
    }

    pub async fn cancel(&self, id: &str) -> Result<EvalRun> {
        check_path_param("eval id", id)?;
        get(self.c, Req::post(format!("/v1/evals/{}/cancel", seg(id)))).await
    }

    pub async fn results(
        &self,
        id: &str,
        model: Option<&str>,
        p: &ListParams,
    ) -> Result<Page<EvalTaskOutcome>> {
        check_path_param("eval id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/evals/{}/results", seg(id)))
                .query(p.query())
                .opt_param("model", model.map(str::to_string)),
        )
        .await
    }

    pub async fn failures(
        &self,
        id: &str,
        model: Option<&str>,
        threshold: Option<f64>,
        p: &ListParams,
    ) -> Result<Page<EvalTaskOutcome>> {
        check_path_param("eval id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/evals/{}/failures", seg(id)))
                .query(p.query())
                .opt_param("model", model.map(str::to_string))
                .opt_param("threshold", threshold),
        )
        .await
    }

    pub async fn outputs(
        &self,
        id: &str,
        model: Option<&str>,
        missing_scorer: Option<&str>,
        p: &ListParams,
    ) -> Result<Page<EvalOutput>> {
        check_path_param("eval id", id)?;
        get(
            self.c,
            Req::get(format!("/v1/evals/{}/outputs", seg(id)))
                .query(p.query())
                .opt_param("model", model.map(str::to_string))
                .opt_param("missing_scorer", missing_scorer.map(str::to_string)),
        )
        .await
    }

    pub async fn post_scores(
        &self,
        id: &str,
        scores: &[LocalScore],
    ) -> Result<PostEvalScoresResponse> {
        check_path_param("eval id", id)?;
        get(
            self.c,
            Req::post(format!("/v1/evals/{}/scores", seg(id))).json(json!({ "scores": scores })),
        )
        .await
    }

    /// Poll until terminal, calling `on_progress` on every poll.
    /// `failed`/`cancelled` return [`Error::EvalFailed`].
    pub async fn wait(
        &self,
        id: &str,
        opts: &WaitOptions,
        mut on_progress: impl FnMut(&EvalRun),
    ) -> Result<EvalRun> {
        let mut poll = Poller::new(opts);
        loop {
            match self.get(id).await {
                Ok(ev) => {
                    on_progress(&ev);
                    match ev.status {
                        EvalStatus::Completed => return Ok(ev),
                        EvalStatus::Failed | EvalStatus::Cancelled => {
                            return Err(Error::EvalFailed(Box::new(ev)))
                        }
                        _ => {
                            if poll.expired() {
                                return Err(poll.timeout_error("eval", id, ev.status.as_str()));
                            }
                        }
                    }
                }
                Err(e) => {
                    poll.on_error(e)?;
                    if poll.expired() {
                        return Err(poll.timeout_error("eval", id, "unknown"));
                    }
                }
            }
            poll.sleep().await;
        }
    }
}
