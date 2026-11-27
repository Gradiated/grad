# Source providers

One class per observability provider. The class owns the provider's format for both file
imports (`grad import --format langfuse`) and live sync (`grad sources add langfuse`).

```
Provider (base.py)                      SyncEngine (sync.py)          HttpClient (http.py)
  name, default_host, page_size,          watermark + re-scan window    egress policy, pinned IP
  requests_per_minute                     settle delay, full rebuild    timeouts, size caps
  auth_headers(secret)          <-------  pagination guards             retries 429/5xx, Retry-After
  fetch_traces(since, cursor)             dedupe by trace id            redirects, pacing
  fetch_scores(since, cursor)             score-update merging          secret redaction
  to_record(raw)                          batches -> emit_batch
  to_score_update(raw)
  detect(row)
     ^
     +-- LangfuseProvider, LangSmithProvider, BraintrustProvider,
         PostHogProvider, PhoenixProvider, GradiatedProvider
```

`PROVIDERS` in `__init__.py` is a plain dict; its order is the file auto-detection order.
`import_runner.run` turns a source job (`{"kind": "provider", "provider", "host", "secret",
"project", "watermark", "full"}`) into `SyncEngine(build_provider(source)).run(...)` and returns
the new watermark in the `ImportSummary`.

## Adding a provider

1. **One file**, `grad_trainer/providers/<name>.py`: subclass `Provider`, set `name`,
   `default_host`, `page_size` and `requests_per_minute` from the provider's docs, and implement
   - `auth_headers(secret)`;
   - `fetch_traces(since, cursor) -> Page`: one page of traces created after `since` (an ISO
     timestamp, or `None` for everything); return the next page's cursor or `None`;
   - `to_record(raw)`: map one row to a grad record. Set `id` to the provider's trace id (the
     merge key), `messages`, `session_id`, `timestamp`, `scores`, `expected_output`, and
     `metadata` via `records.record_metadata(name, provider_metadata, model=..., version=...,
     tags=..., user_id=...)`;
   - if feedback is separate from traces: `fetch_scores(since, cursor)` and
     `to_score_update(raw) -> ScoreUpdate(trace_id, scores, expected_output, updated_at)`.
     `since` already includes the 7-day re-scan window; return `updated_at` so the engine can
     drop feedback it synced before. If the provider merges feedback into the trace row and
     bumps a version (Braintrust), skip both and use `cursor_watermark` with `Page.resume`;
   - optionally `detect(row)` for file auto-detection.
   Use `self.http.get/post/request` for every call, never `urllib` directly, and
   `self.items(body, "data")` to read lists so a changed response shape raises
   `SourceAPIChangedError`.
2. **One registry line** in `__init__.py`.
3. **One fixture set**, `tests/fixtures/providers/<name>.py`: a `ProviderFixture` that answers
   the provider's endpoints in its documented shapes, plus one line in that package's
   `FIXTURES`. `tests/providers/test_contract.py` then runs the whole contract against it
   (pagination, incremental sync, late scores, full rebuild, retries, cursor loops, auth
   failure, secret redaction, metadata mapping). Put only quirks in `test_quirks.py`.
4. **One docs page**, `product/website/src/docs/training/integrations/<name>.mdx`, with the
   field mapping, the key it needs and its hosts.

## Behaviour every provider gets

- **Watermark.** `{"traces": T, "scores": S}`, stored by grad-server when the job completes.
  Traces are read from `T`; scores from `min(S, now - 7 days)`, so feedback edited later still
  lands. Only rows up to `now - 10 min` are taken (Langfuse documents ~10 minutes before reads
  see new data); the rest wait for the next sync. `full=True` ignores the watermark.
- **Merging.** Score updates are records with `metadata.score_update = true`. The worker folds
  dataset parts with `records.merge_records` before training: later content replaces earlier
  content, later scores win per name, updates for traces never synced are dropped.
- **Errors.** `SourceAuthError` (401/403, malformed key), `SourceUnreachableError` (DNS,
  connection, persistent 429/5xx, redirect loops, slow pages), `SourceHostBlockedError`
  (scheme or address), `SourceAPIChangedError` (other statuses, unexpected shapes, oversized
  pages) and `PaginationLoopError` (repeated cursor, too many pages). Messages never include
  response bodies or secrets.
- **Egress.** https only (plain http to loopback or allowlisted networks). Private, loopback,
  link-local/metadata, CGNAT, multicast and reserved addresses are refused unless listed in
  `GRAD_SOURCES_EGRESS_ALLOW` (comma-separated CIDRs); `GRAD_SOURCES_EGRESS_DENY` blocks more.
  The client connects to the vetted IP, so DNS rebinding can't swap it.
