#!/usr/bin/env bash
# Boot the local stack from source with `grad local up --build --dev-models`,
# run the quickstarts (including the README's router on the sample traces)
# through the CLI and the Python SDK (CPU torch trainer, tiny dev models), eval
# the trained artifact with a validator and the test/tiny-judge judge on
# grad-dev-inference and render the report (CLI, Python SDK and, with
# GRAD_SMOKE_UI=1, the web console's live test), restart it to check the data
# persists, then `grad local down --volumes` and check nothing is left.
#
#   GRAD_BIN=target/debug/grad GRAD_SMOKE_PYTHON=python3 tests/compose/smoke.sh
#
# GRAD_SMOKE_PROJECT (default grad-smoke) names the compose project.
# GRAD_SMOKE_PORT pins the loopback API port; by default `grad local up` picks
# 18787 or a free fallback and the 'local' profile follows it. The Python must
# have httpx; the SDK is imported from sdks/python. KEEP=1 leaves the stack up.
# GRAD_SMOKE_UI=1 also runs server/ui's live tests (needs `pnpm -C server/ui install`).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
GRAD=${GRAD_BIN:-grad}
PY=${GRAD_SMOKE_PYTHON:-python3}
export COMPOSE_PROJECT_NAME=${GRAD_SMOKE_PROJECT:-grad-smoke}
if [ -n "${GRAD_SMOKE_PORT:-}" ]; then export GRAD_PORT=$GRAD_SMOKE_PORT; else unset GRAD_PORT; fi
unset GRAD_GRAFANA_PORT GRAD_PROMETHEUS_PORT
export GRAD_COMPOSE_FILE="$ROOT/server/docker-compose.yml:$ROOT/tests/compose/smoke.yml"
# About 3 GB for the whole stack.
export GRAD_POSTGRES_MEMORY=${GRAD_POSTGRES_MEMORY:-256m}
export GRAD_SERVER_MEMORY=${GRAD_SERVER_MEMORY:-768m}
export GRAD_TRAINER_MEMORY=${GRAD_TRAINER_MEMORY:-2g}
export GRAD_DEV_INFERENCE_MEMORY=${GRAD_DEV_INFERENCE_MEMORY:-768m}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/grad-smoke.XXXXXX")
export XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" GRADIATED_PROFILE=local
unset GRADIATED_API_KEY GRADIATED_BASE_URL
cd "$WORK"

step() { printf '\n== %s (at %ss)\n' "$*" "$SECONDS"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    "$GRAD" local logs --tail 200 >&2 || true
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    "$GRAD" local down --volumes >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

step "grad local up --build"
"$GRAD" local up --build --dev-models --timeout 600
"$GRAD" models list | grep -q test/tiny-qwen3 || fail "tiny model not in the catalog"
local_url() { "$GRAD" --json local status | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["data"]["base_url"])'; }
API_URL=$(local_url)

step "grad local up again while running: its own ports are not a clash"
"$GRAD" --json local up --build --dev-models --timeout 600 > up-again.json
"$PY" -c 'import json,sys; d=json.load(open("up-again.json"))["data"]; sys.exit(d["base_url"] != sys.argv[1])' "$API_URL" \
  || fail "second up moved off its own port"

step "CLI quickstart: import, plan, train, download, eval"
for i in $(seq 0 23); do
  printf '{"session_id":"s%s","messages":[{"role":"user","content":"Reset my password %s"},{"role":"assistant","content":"Open Settings, then Security."}]}\n' "$i" "$i"
done > support_traces.jsonl
"$GRAD" import ./support_traces.jsonl --dataset support-prod | tee import.out
grep -q "imported 24 records" import.out || fail "import"
TRAIN=(--dataset support-prod --name support-sft --recipe sft --model test/tiny-qwen3 --batch-size 8)
"$GRAD" train "${TRAIN[@]}" --dry-run
"$GRAD" train "${TRAIN[@]}" --max-cost-usd 5 --wait | tee train.out
grep -q "Exported artifact support-sft@" train.out || fail "train"
"$GRAD" artifacts download support-sft@latest --output ./support-sft
test -f support-sft/adapter_config.json && test -f support-sft/adapter_model.safetensors || fail "artifact files"
printf -- '- name: nonempty\n  kind: validator\n  validator: non_empty\n- name: overlap\n  kind: judge\n  model: test/tiny-judge\n' > rubric.yaml
"$GRAD" eval --name smoke --models support-sft@latest,test/tiny-qwen3 --dataset support-prod \
  --rubric rubric.yaml --limit 5 --baseline test/tiny-qwen3 --wait | tee eval.out
grep -q "support-sft@" eval.out && grep -q "completed" eval.out || fail "eval"
EVAL_ID=$("$GRAD" --json eval list | "$PY" -c 'import json,sys; print(next(e["id"] for e in json.load(sys.stdin)["data"]["data"] if e["name"] == "smoke"))')
"$GRAD" --json eval status "$EVAL_ID" > eval.json
# Real outputs from grad-dev-inference: every task generated and judged, no errors.
"$PY" - eval.json <<'PY' || fail "eval report"
import json, sys
ev = json.load(open(sys.argv[1]))["data"]
assert ev["status"] == "completed", ev["status"]
assert ev["judge_models"] == ["test/tiny-judge"], ev["judge_models"]
rows = {r["model"]: r for r in ev["summary"]}
assert set(rows) == {"test/tiny-qwen3"} | {m for m in rows if m.startswith("support-sft@")} and len(rows) == 2, rows
for row in rows.values():
    assert row["tasks"] == 5 and row["errors"] == 0 and row["tokens_per_task"] > 0, row
print("eval report ok:", {m: r["overall"] for m, r in rows.items()})
PY
"$GRAD" eval results "$EVAL_ID" | tee eval-results.out
grep -q "support-sft@" eval-results.out || fail "eval results"

step "README quickstart: a router on examples/support_traces.jsonl (dev models)"
"$GRAD" import "$ROOT/examples/support_traces.jsonl" --dataset support-traces | tee readme-import.out
grep -q "imported 96 records" readme-import.out || fail "README import"
"$GRAD" train --dataset support-traces --name support-router --recipe router --model test/tiny-qwen3 \
  --set rubric=resolved --max-cost-usd 1 --wait | tee router.out
grep -q "Exported artifact support-router@" router.out || fail "README router"
"$GRAD" artifacts download support-router@latest --output ./support-router
test -f support-router/router_config.json || fail "router artifact files"

step "workspace secrets (GRAD_SECRETS_KEY from the local profile)"
printf 'hf_smoke_not_a_real_token' | "$GRAD" secrets set hf-token
"$GRAD" secrets list | tee secrets.out
grep -q hf-token secrets.out || fail "secret not listed"
grep -q hf_smoke_not_a_real_token secrets.out && fail "secret value echoed"

step "Python SDK quickstart"
PYTHONPATH="$ROOT/sdks/python" "$PY" "$ROOT/tests/compose/smoke_sdk.py"

if [ "${GRAD_SMOKE_UI:-0}" = 1 ]; then
  step "web console: runs and the judged eval's report (server/ui live tests)"
  ADMIN_KEY=$("$PY" -c 'import json,os,sys; print(json.load(open(os.path.join(os.environ["XDG_CONFIG_HOME"], "gradiated", "config.json")))["profiles"]["local"]["api_key"])')
  GRAD_LIVE_BASE_URL=$API_URL GRAD_LIVE_API_KEY=$ADMIN_KEY GRAD_LIVE_EVAL_ID=$EVAL_ID \
    pnpm -C "$ROOT/server/ui" exec vitest run --config vitest.live.config.ts || fail "web console"
fi

step "grad local status / logs"
"$GRAD" local status | tee status.out
grep -q "ready" status.out || fail "status"
grep -q "Web UI:     $API_URL/" status.out || fail "status UI URL"
"$GRAD" local logs grad-server --tail 20 | grep -q "grad-server listening" || fail "logs"

step "restart: data persists"
"$GRAD" local down
"$GRAD" local up --build --dev-models --timeout 600
"$GRAD" --json runs list > runs.out || true
grep -q '"support-sft"' runs.out || fail "run lost across restart: $(cat runs.out)"
[ "$(local_url)" = "$API_URL" ] || fail "URL changed across restart"
"$GRAD" secrets list | grep -q hf-token || fail "secret lost across restart"
rm -rf support-sft
"$GRAD" artifacts download support-sft@latest --output ./support-sft
test -f support-sft/adapter_model.safetensors || fail "artifact lost across restart"

step "grad local down --volumes: nothing left"
"$GRAD" local down --volumes
left=$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
vols=$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
[ -z "$left$vols" ] || fail "left behind: containers [$left] volumes [$vols]"
echo "compose smoke test passed"
