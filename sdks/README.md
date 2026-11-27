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
| Dataset scoring (`dataset.score(rubric).wait()` → the scored version) and filtered views (`dataset.filter(scores=...)`, or a local function saved as ids) | same, cases `score_dataset`, `filter_dataset_fields`, `filter_dataset_ids`; `test_resources.DatasetTests.test_score_*`/`test_filter_*`; live `test_dataset_score_and_filter` | same; `resources.test.ts` "dataset scoring and filters"; live "scores a dataset..." | same; `TestDatasetScore*`, `TestDatasetFilter*`; live `TestLiveSelfHosted/score_a_dataset...` | same; `sdk.rs::dataset_scoring_waits_and_filters_stream_ids` | same (`grad datasets score`, `grad datasets filter`); `cli.rs::dataset_score_and_filter_commands`; live quickstart |
| Built-in benchmarks as datasets (`from_benchmark("gsm8k", limit=200)`; evals on them default to the benchmark's answer check) | same, case `import_benchmark`; `test_resources.DatasetTests.test_from_benchmark`; live `test_benchmark_import_is_pinned` | same, `fromBenchmark`; `resources.test.ts` "imports a built-in benchmark"; live "queues a pinned benchmark import" | same, `ImportBenchmark` / `FromBenchmark`; `TestFromBenchmarkImportsAndWaits`; live `TestLiveSelfHosted/a_benchmark_import_is_pinned` | same, `datasets().import_benchmark` | same (`grad datasets import benchmark`); live quickstart |
| Recipe `evals=` (scored on every checkpoint) and `loggers=` (W&B, MLflow; keys from workspace secrets) | same, case `plan_sft_checkpoint_evals_loggers`; `test_recipes.RecipeTests.test_checkpoint_evals_and_loggers`; live `test_checkpoint_evals_and_mlflow_logger` (a real worker streams to a fake MLflow) | same, `evals`, `loggers.wandb/mlflow`; `recipes.test.ts` "maps checkpoint evals and loggers"; live "plans checkpoint evals and loggers" | same, `Common.Evals`, `WandB` / `MLflow`; `TestCheckpointEvalsRejectLocalScorers`; live `TestLiveSelfHosted/checkpoint_evals_and_loggers_are_planned` | same, `RecipeSpec.evals` / `loggers` | same (`evals:` / `loggers:` in the run file); live quickstart |

Each SDK also runs its own live suite against `tests/harness/stack.ts`
(`tests/test_live.py`, `test/live/`, `live_test.go`, `cli/tests/live.rs`).
