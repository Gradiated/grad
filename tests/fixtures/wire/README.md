# Shared wire fixtures

Real HTTP bodies for SDK unit tests. Every SDK's fake transport replays these
files, so the TypeScript, Go, Python and Rust clients are tested against the
same shapes and the same error-mapping table.

- `errors.json`: error-mapping cases (status, headers, body) with the typed
  error each SDK must raise.
- `problem-*.json`: problem+json responses captured from a live server.
- `source-filter-keys.json`: each source provider's filter keys; the trainer's
  providers and grad-server's validation are both tested against it.
- Everything else: response bodies captured from a live self-hosted stack with
  the reference worker (`node tests/fixtures/wire/capture.mjs`). The
  deployment bodies (`deployment*.json`, `deployments-page.json`) need Cloud
  serving and are written by hand from `spec/openapi.yaml`.

Add language-specific files with a language prefix (`py-`, `rs-`, `go-`, `ts-`).
