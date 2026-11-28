# `Gradiated/grad` Agent Guidelines

- Keep complexity low: prefer small modules, explicit contracts, and minimal dependencies.
- `spec/openapi.yaml` is the single source of truth for the HTTP wire contract. Regenerate it from `server/api` and regenerate all 4 SDK transport clients via `node scripts/generate-sdks.mjs`. CI enforces zero drift with `--check`.
- Self-hosted parity is a hard invariant: `server/api` must require only PostgreSQL and S3-compatible storage, with zero Cloud-only datastore dependencies. Cloud auth, billing, and deploy bridge through narrow adapters.
- TypeScript code uses `const` arrow functions, strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Zod parsing at store boundaries, blank lines between logical steps, and minimal comments.
- Pin every GitHub Action in `.github/workflows/` to a full-length commit SHA with a version comment.
- Never commit credentials, API keys, or customer payloads.
