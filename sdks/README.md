# grad SDKs

| SDK | Path | Client | Generated from `spec/openapi.yaml` |
|---|---|---|---|
| Python | `sdks/python` | `grad.Grad` (blocking, on `httpx`) | `grad/_generated/client.py` (wire client, TypedDicts) |
| TypeScript | `sdks/typescript` | `Grad` | `src/generated/` (models, client); `src/transport.ts` is hand-written |
| Go | `sdks/go` | `grad.NewClient` | `generated/models.go`, `client.go`; `generated/transport.go` is hand-written |
| Rust | `sdks/rust` | `grad_sdk::Client` (used by the CLI) | `src/generated.rs`: the models the hand-written client uses |
| CLI | `cli` | `grad` | through the Rust SDK |

Regenerate after a contract change: `pnpm -C server/api openapi:generate`, then
`node scripts/generate-sdks.mjs` (`--check` fails on drift).

## Parity

Every v0 feature works in every SDK and the CLI. The shared fixture
`tests/fixtures/wire/sdk-parity.json` holds the request each client must send for
the same logical call (method, path, body, `Idempotency-Key`) and response bodies
whose typed fields each client reads back; every column below replays it.

| Feature | Python | TypeScript | Go | Rust | CLI |
|---|---|---|---|---|---|
| Every v0 recipe parameter (common, optimizer, `eval_every`, losses, router rubric/pricing/fallback, cartridge, pooling, split) | `test_parity.ParityTests.test_requests_match_the_shared_fixture` | `parity.test.ts` "sends the fixture's request for every case" | `TestParityRequests` | `parity.rs::requests_match_the_shared_fixture` | `cli.rs::parity_requests_match_the_shared_fixture` (`grad train -f`) |
| `DistillRecipe` (teacher, on/off-policy rollout, top-k KL or cross-entropy, teacher-only context) and `RewardModelRecipe` (pairwise + pointwise `rubric`) | same, cases `plan_distill`, `plan_distill_off_policy`, `plan_reward` | same, `recipes.distill` / `rollouts.*` / `recipes.rewardModel` | same, `DistillRecipe` / `RewardModelRecipe` | same, `recipes::on_policy` / `recipes::off_policy` | same (`--recipe distill --teacher --rollout --max-new-tokens`, `--recipe reward-model --score`) |
| Continued training (`model` = an artifact) | same, case `create_dpo_from_artifact` | same | same | same | same (`--model NAME@VERSION` or `model:` in the run file) |
| Caller-supplied `Idempotency-Key` (runs, evals, deploy) | same, `idempotency_key=` | same, `{ idempotencyKey }` | same, `IdempotencyKey` / `WithDeployIdempotencyKey` | same, `create(&req, Some(key))` | same, `--idempotency-key` |
| Typed `eval_report` and `eval_metrics` | `test_parity.ParityTests.test_typed_responses` | "reads typed eval reports, eval metrics and eval billing" | `TestParityTypedResponses` | `parity.rs::typed_responses` | `cli.rs::train_wait_streams_metrics_and_prints_the_readout` |
| Eval billing (`estimated_cost_usd`, `total_cost_usd`, cost per 1k tasks) | same | same | same | same | `cli.rs::eval_commands` |

Each SDK also runs its own live suite against `tests/harness/stack.ts`
(`tests/test_live.py`, `test/live/`, `live_test.go`, `cli/tests/live.rs`).
