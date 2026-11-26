# `grad`

Model training, serving, and trajectory platform by Gradiated — runs identically locally (`grad local up`), self-hosted in Kubernetes (`server/helm/grad`), and in Gradiated Cloud.

## Repository layout

```text
grad/
├── spec/
│   └── openapi.yaml           # Authoritative OpenAPI 3.1 contract (emitted from server/api)
├── server/
│   ├── api/                   # Standalone OpenAPI 3.1 HTTP server (Postgres + S3 / local FS)
│   ├── trainer/               # Python training engine, 6 v0 recipes, & trace connectors
│   ├── docker-compose.yml     # One-command local stack (`grad local up`)
│   └── helm/grad/             # Self-hosted Kubernetes Helm chart
├── cli/                       # Rust `grad` CLI binary
├── sdks/
│   ├── python/                # `grad-sdk` (generated client + idiomatic façade + `env serve`)
│   ├── typescript/            # `@gradiated/grad` (generated client + native-fetch façade)
│   ├── go/                    # `github.com/Gradiated/grad/sdks/go`
│   └── rust/                  # `grad-sdk` crate
├── scripts/
│   └── generate-sdks.mjs      # Deterministic OpenAPI -> 4-SDK codegen (`--check` in CI)
└── tests/
    └── contract/              # Cross-language wire & E2E tests against live server + trainer
```

## Quick start

```bash
# Start local server + trainer + Postgres
grad local up

# Run tests across server, trainer, SDKs, and CLI
mise exec -- pnpm -C server/api check
```
