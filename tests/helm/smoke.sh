#!/usr/bin/env bash
# Install the grad chart on a throwaway kind cluster and exercise it:
# readiness, the migrations Job, a run claimed by a `train` worker while both
# API pods are force-deleted, `helm upgrade` and `helm uninstall`.
#
#   scripts/install-k8s-tools bin && PATH=$PWD/bin:$PATH tests/helm/smoke.sh
#
# GRAD_KIND_CLUSTER (default grad-kind) names the cluster; its node is capped at
# GRAD_KIND_MEMORY (default 3g). GRAD_SERVER_IMAGE / GRAD_TRAINER_IMAGE reuse
# images that are already built (else server/api and the trainer's cpu target
# are built here). KEEP=1 leaves the cluster up.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLUSTER=${GRAD_KIND_CLUSTER:-grad-kind}
NODE_IMAGE=kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5
NS=grad
RELEASE=grad
CHART="$ROOT/server/helm/grad"
export KUBECONFIG="${TMPDIR:-/tmp}/kubeconfig-$CLUSTER"

step() { printf '\n== %s\n' "$*"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    kubectl -n "$NS" get pods -o wide >&2 || true
    kubectl -n "$NS" logs -l app.kubernetes.io/instance=$RELEASE --all-containers --tail 50 --prefix >&2 || true
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
    rm -f "$KUBECONFIG"
  fi
  exit "$status"
}
trap cleanup EXIT

step "images"
if [ -n "${GRAD_SERVER_IMAGE:-}" ]; then docker tag "$GRAD_SERVER_IMAGE" grad-server:dev
else docker build -q -f "$ROOT/server/api/Dockerfile" -t grad-server:dev "$ROOT"; fi
if [ -n "${GRAD_TRAINER_IMAGE:-}" ]; then docker tag "$GRAD_TRAINER_IMAGE" grad-trainer:dev
else docker build -q --target cpu -t grad-trainer:dev "$ROOT/server/trainer"; fi

step "kind cluster $CLUSTER"
kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 120s
docker update --memory "${GRAD_KIND_MEMORY:-3g}" --memory-swap "${GRAD_KIND_MEMORY:-3g}" "$CLUSTER-control-plane" >/dev/null
kind load docker-image --name "$CLUSTER" grad-server:dev grad-trainer:dev

step "fixtures: Postgres and SeaweedFS with its bucket (no grad Secret: the chart creates it)"
kubectl create namespace "$NS"
kubectl -n "$NS" apply -f "$ROOT/tests/helm/fixtures.yaml"
kubectl -n "$NS" rollout status deploy/postgres deploy/seaweedfs --timeout 180s

step "helm install"
helm install "$RELEASE" "$CHART" -n "$NS" -f "$CHART/ci/kind-values.yaml" --wait --timeout 6m
SECRET="$RELEASE-grad"
secret_key() { kubectl -n "$NS" get secret "$SECRET" -o jsonpath="{.data.$1}" | base64 -d; }
ADMIN_KEY=$(secret_key admin-api-key)
[[ "$ADMIN_KEY" == grad_* ]] || { echo "FAIL: the chart did not generate an admin key" >&2; exit 1; }
[ "$(printf '%s' "$ADMIN_KEY" | sha256sum | cut -d' ' -f1)" = "$(secret_key admin-api-key-hash)" ]
[ "$(secret_key secrets-key | base64 -d | wc -c)" -eq 32 ] || { echo "FAIL: secrets-key is not 32 bytes" >&2; exit 1; }
# One generated key per pool, each scoped to its pool's job kinds.
secret_key trainer-keys-json | python3 -c 'import json,sys; keys=json.load(sys.stdin); assert sorted((k["label"],k["kinds"]) for k in keys) == [("import",["import","eval"]),("train",["train"])], keys'
GENERATED=$(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data}')
# KEDA's metrics-api trigger (keda.trigger=metrics-api) reads each pool's queue
# depth from grad-server's metrics port; the prometheus trigger reads
# grad_jobs_open from /metrics. Both must answer from inside the cluster.
helm template "$RELEASE" "$CHART" -n "$NS" -f "$CHART/ci/kind-values.yaml" --set keda.enabled=true --set keda.trigger=metrics-api \
  | python3 -c 'import json,re,sys; [print(json.loads(u)) for u in re.findall(r"^ +url: (\".*\")$", sys.stdin.read(), re.M)]' \
  | while read -r url; do
      body=$(kubectl -n "$NS" exec deploy/"$RELEASE-grad-api" -- node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>console.log(t))" "$url")
      python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert isinstance(d["open"], int), d' "$body" \
        || { echo "FAIL: KEDA metrics-api $url answered '$body'" >&2; exit 1; }
      echo "ok: KEDA metrics-api $url -> $body"
    done
kubectl -n "$NS" exec deploy/"$RELEASE-grad-api" -- node -e \
  "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>{if(!/^grad_jobs_open\{kind=\"train\"\} \d+/m.test(t))process.exit(1)})" \
  || { echo "FAIL: /metrics has no grad_jobs_open series" >&2; exit 1; }
echo "ok: /metrics exports grad_jobs_open"
python3 "$ROOT/tests/helm/smoke.py" --namespace "$NS" --release "$RELEASE" --admin-key "$ADMIN_KEY"

step "helm upgrade"
helm upgrade "$RELEASE" "$CHART" -n "$NS" -f "$CHART/ci/kind-values.yaml" \
  --set api.env.MAX_ATTEMPTS=5 --wait --timeout 6m
kubectl -n "$NS" get deploy "$RELEASE-grad-api" -o jsonpath='{.spec.template.spec.containers[0].env}' | grep -q MAX_ATTEMPTS
kubectl -n "$NS" rollout status deploy/"$RELEASE-grad-api" --timeout 180s
test "$(helm -n "$NS" history "$RELEASE" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["status"])')" = deployed
[ "$(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data}')" = "$GENERATED" ] || { echo "FAIL: helm upgrade changed the generated keys" >&2; exit 1; }

step "helm uninstall"
helm uninstall "$RELEASE" -n "$NS" --wait --timeout 3m
# Workers drain on SIGTERM (terminationGracePeriodSeconds) before their pods go.
kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/instance=$RELEASE --timeout 120s
left=$(kubectl -n "$NS" get all,serviceaccount,pdb,job,networkpolicy -l app.kubernetes.io/instance=$RELEASE -o name)
[ -z "$left" ] || { echo "FAIL: left behind: $left" >&2; exit 1; }
# The Secret outlives the release, so a reinstall keeps its keys and workspace secrets.
kubectl -n "$NS" get secret "$SECRET" >/dev/null
echo "helm smoke test passed"
