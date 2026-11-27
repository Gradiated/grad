# Contributing to grad

Thanks for helping. Bug reports, fixes, docs and new recipes are all welcome. For anything
bigger than a small fix, open an issue first so we can agree on the shape before you write
the code.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Setup

You need Docker (the server tests and the live SDK suites start a throwaway Postgres
container) and the toolchains pinned in [`mise.toml`](mise.toml): Node, pnpm, Python, Go,
Rust and Helm. With [mise](https://mise.jdx.dev):

```bash
git clone https://github.com/Gradiated/grad && cd grad
mise install
pnpm -C server/api install --frozen-lockfile
```

## Running the tests

Run the checks for the parts you touched. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
runs all of them on every pull request.

```bash
# grad-server (TypeScript)
pnpm -C server/api format:check
pnpm -C server/api check                 # typecheck + tests

# grad-trainer (Python, CPU torch)
python3 -m venv .venv-trainer
.venv-trainer/bin/pip install --require-hashes --no-deps -r server/trainer/requirements-cpu.lock
.venv-trainer/bin/pip install -r server/trainer/requirements-dev.txt
(cd server/trainer && PYTHONPATH=. ../../.venv-trainer/bin/python -m unittest discover -s tests)

# Python SDK
pip install -e "sdks/python[dev]"
python3 -m unittest discover -s sdks/python/tests
(cd sdks/python && mypy)

# TypeScript SDK
pnpm -C sdks/typescript install --frozen-lockfile
pnpm -C sdks/typescript check
pnpm -C sdks/typescript test:live        # against a live local stack

# Go SDK
(cd sdks/go && gofmt -l . && go vet ./... && go test ./...)

# Rust SDK and CLI
cargo fmt --check --package grad-cli
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace

# Helm chart
helm lint server/helm/grad --strict
```

The SDK and CLI live suites boot a real stack from [`tests/harness/stack.ts`](tests/harness/stack.ts).
To run the whole thing by hand from your checkout, use `grad local up --build`.

## Changing the API

[`spec/openapi.yaml`](spec/openapi.yaml) is the wire contract, and it is generated, never
edited by hand. The routes in `server/api` are the source; the four SDK transports are
generated from the spec:

```bash
pnpm -C server/api openapi:generate      # server/api -> spec/openapi.yaml
node scripts/generate-sdks.mjs           # spec -> Python, TypeScript, Go and Rust transports
```

Commit the regenerated files with your change. CI fails if either is out of date
(`pnpm -C server/api openapi:check` and `node scripts/generate-sdks.mjs --check`). A new
endpoint usually also needs a hand-written method in each SDK and the CLI, plus a wire fixture
in `tests/fixtures/wire/`, so the four SDKs stay at parity.

Two rules hold everywhere:

- Self-hosted `grad` needs only PostgreSQL and S3 (or a local directory). Cloud-only features
  go through the narrow auth, billing and deploy adapters, never as a hard dependency.
- Never commit credentials, API keys or customer data, including in test fixtures.

## Pull requests

- Keep each pull request to one change, and add or update tests with it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `fix(sdk-go): ...`, `feat(api): ...`, `docs(readme): ...`. Scopes in use include `api`,
  `trainer`, `codegen`, `cli`, `sdk-python`, `sdk-ts`, `sdk-go` and `sdk-rust`.
- Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user would
  notice.
- Pin any new GitHub Action to a full commit SHA with a version comment
  (`uses: actions/checkout@<sha> # v7.0.1`). [pinact](https://github.com/suzuki-shunsuke/pinact)
  does this for you: `pinact run`.

## Releasing

Every package (server, trainer, Helm chart, the four SDKs and the CLI) ships with the same
version. To release `0.3.0`:

1. Set the version everywhere and turn `## Unreleased` into the `0.3.0` section:

   ```bash
   scripts/bump-version 0.3.0
   ```

   Edit the new CHANGELOG section if it needs it, then commit it to `main` as
   `chore: release v0.3.0`.

2. Tag that commit on `main` and push the tag:

   ```bash
   git tag -a v0.3.0 -m v0.3.0 && git push origin v0.3.0
   ```

3. [`release.yml`](.github/workflows/release.yml) checks that the tagged commit is on `main`
   and that the tag matches every version field, builds the Python sdist and wheel and the CLI
   binaries, then waits for a maintainer to approve the `release` environment. Once approved it
   publishes:

   - `grad-sdk` to PyPI and `@gradiated/grad` to npm (with provenance),
   - `grad-sdk`, then `grad-cli`, to crates.io,
   - the Go module, by pushing the tag `sdks/go/v0.3.0` (Go modules in a subdirectory are
     versioned by tags with that prefix, so users run `go get github.com/Gradiated/grad/sdks/go@v0.3.0`),
   - `docker.io/gradiated/grad-server` and `docker.io/gradiated/grad-trainer` (`0.3.0` for CPU,
     `0.3.0-gpu` for CUDA), mirrored to `ghcr.io/gradiated/`, with SBOM and provenance
     attestations, through
     [`images.yml`](.github/workflows/images.yml), the workflow that also publishes `main` and
     `sha-<7>` on every push to `main`,
   - the Helm chart to `oci://ghcr.io/gradiated/charts/grad`.

   After that, a second approval creates the GitHub Release with the CHANGELOG notes, the CLI
   archives, the Python distributions, the chart and `sha256sums.txt`.

A version with a suffix, like `0.3.0-rc.1`, is a prerelease: npm gets the `next` dist-tag, the
images don't move `latest` and the GitHub Release is marked as a prerelease.

If a publish job fails, fix the cause and re-run the failed jobs; jobs that already succeeded
don't run again. Registries never accept the same version twice, so a broken release is fixed
with a new patch version, not by moving the tag.

### Repository settings

These are configured on GitHub, not in this repository:

- The `release` environment requires a maintainer's approval, and only `v*` tags may deploy to
  it.
- `main` blocks force pushes and deletion. It doesn't require pull request reviews or status
  checks yet: commits land on `main` directly, and CI runs after each push.

### One-time setup

- PyPI: a trusted publisher for `grad-sdk` (repository `Gradiated/grad`, workflow
  `release.yml`, environment `release`). PyPI allows this before the project exists.
- npm and crates.io only allow a trusted publisher on a package that already exists. For the
  first release, add `NPM_TOKEN` and `CARGO_REGISTRY_TOKEN` as secrets of the `release`
  environment. Afterwards, configure trusted publishing for `@gradiated/grad`, `grad-sdk` and
  `grad-cli` with the same workflow and environment, then delete both secrets.
- Docker Hub: the `gradiated` organization's public repositories `grad-server` and
  `grad-trainer`, and the repository secrets `DOCKERHUB_USERNAME` (`gradiated`, the
  organization name, for an organization access token) and `DOCKERHUB_TOKEN` (an organization
  access token with Image Pull and Push). Pushes to `main` also sync each repository's overview
  from [`deploy/dockerhub/`](deploy/dockerhub); that step only warns if the token can't edit
  repositories.
- GHCR: after the first push, make `grad-server`, `grad-trainer` and `charts/grad` public and
  connect them to this repository.
