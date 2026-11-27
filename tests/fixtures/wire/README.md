# Shared wire fixtures

Real HTTP bodies for SDK unit tests. Every SDK's fake transport replays these
files, so the TypeScript, Go, Python and Rust clients are tested against the
same shapes and the same error-mapping table.

- `errors.json`: error-mapping cases (status, headers, body) with the typed
  error each SDK must raise.
- `problem-*.json`: problem+json responses captured from a live server.
- Everything else: response bodies captured from a live self-hosted stack with
  the reference worker (`node tests/fixtures/wire/capture.mjs`). The
  deployment, route, feedback and embeddings bodies need Cloud serving and are
  written by hand from `spec/openapi.yaml`.

Add language-specific files with a language prefix (`py-`, `rs-`, `go-`, `ts-`).
