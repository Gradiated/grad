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
│   ├── docker-compose.yml     # Source-build local stack (`grad local up --build`)
│   └── helm/grad/             # Self-hosted Kubernetes Helm chart
├── cli/                       # Rust `grad` CLI binary (embeds assets/docker-compose.yml for `grad local up`)
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
# Build the CLI (binary: target/release/grad)
cargo build --release --bin grad

# Start Postgres, the API on 127.0.0.1:8787 and a CPU trainer from published images.
# First run generates an admin and a trainer key and saves them in the 'local' profile.
grad local up
export GRADIATED_PROFILE=local

# Import traces, check the plan, train and download the adapter
grad import ./support_traces.jsonl --dataset support-prod
grad train --dataset support-prod --name support-sft --recipe sft --dry-run
grad train --dataset support-prod --name support-sft --recipe sft --wait
grad artifacts download support-sft@latest --output ./support-sft

grad local down            # add --volumes to delete data
```

Against a remote server, `grad login` saves the key and base URL instead (`grad login --base-url URL --profile NAME`). `grad --help` lists every command, the configuration precedence and the exit codes; `--json` on any command prints one machine-readable envelope.

```bash
# Run tests across server, trainer, SDKs, and CLI
mise exec -- pnpm -C server/api check
cargo test --workspace
```
