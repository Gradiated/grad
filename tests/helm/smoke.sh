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
ADMIN_KEY="grad_kind_admin_$(openssl rand -hex 12)"
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
else docker build -q -t grad-server:dev "$ROOT/server/api"; fi
if [ -n "${GRAD_TRAINER_IMAGE:-}" ]; then docker tag "$GRAD_TRAINER_IMAGE" grad-trainer:dev
else docker build -q --target cpu -t grad-trainer:dev "$ROOT/server/trainer"; fi

step "kind cluster $CLUSTER"
kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 120s
docker update --memory "${GRAD_KIND_MEMORY:-3g}" --memory-swap "${GRAD_KIND_MEMORY:-3g}" "$CLUSTER-control-plane" >/dev/null
kind load docker-image --name "$CLUSTER" grad-server:dev grad-trainer:dev

step "fixtures: Postgres, MinIO, the bucket and the Secret"
kubectl create namespace "$NS"
kubectl -n "$NS" apply -f "$ROOT/tests/helm/fixtures.yaml"
kubectl -n "$NS" rollout status deploy/postgres deploy/minio --timeout 180s
kubectl -n "$NS" run make-bucket --rm -i --restart=Never --image grad-server:dev --image-pull-policy Never \
  --env AWS_ACCESS_KEY_ID=gradkind --env AWS_SECRET_ACCESS_KEY=grad-kind-only-secret -- \
  node --input-type=module -e "import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
    await new S3Client({endpoint:'http://minio:9000',region:'us-east-1',forcePathStyle:true}).send(new CreateBucketCommand({Bucket:'grad-kind'}))"
kubectl -n "$NS" create secret generic grad \
  --from-literal=database-url="postgres://grad:grad-kind-only@postgres:5432/grad" \
  --from-literal=admin-api-key-hash="$(printf '%s' "$ADMIN_KEY" | sha256sum | cut -d' ' -f1)" \
  --from-literal=trainer-api-key="grad_kind_trainer_$(openssl rand -hex 12)" \
  --from-literal=secrets-key="$(openssl rand -base64 32)" \
  --from-literal=aws-access-key-id=gradkind \
  --from-literal=aws-secret-access-key=grad-kind-only-secret

step "helm install"
helm install "$RELEASE" "$CHART" -n "$NS" -f "$CHART/ci/kind-values.yaml" --wait --timeout 6m
# The KEDA trigger queries (keda.enabled=true) must run against the migrated schema.
helm template "$RELEASE" "$CHART" -f "$CHART/ci/kind-values.yaml" --set keda.enabled=true \
  | python3 -c 'import json,re,sys; [print(json.loads(q)) for q in re.findall(r"^ +query: (\".*\")$", sys.stdin.read(), re.M)]' \
  | while read -r query; do
      n=$(kubectl -n "$NS" exec deploy/postgres -- psql -U grad -d grad -tAc "$query")
      [[ "$n" =~ ^[0-9]+$ ]] || { echo "FAIL: KEDA query returned '$n': $query" >&2; exit 1; }
      echo "ok: KEDA query counts $n open jobs"
    done
python3 "$ROOT/tests/helm/smoke.py" --namespace "$NS" --release "$RELEASE" --admin-key "$ADMIN_KEY"

step "helm upgrade"
helm upgrade "$RELEASE" "$CHART" -n "$NS" -f "$CHART/ci/kind-values.yaml" \
  --set api.env.MAX_ATTEMPTS=5 --wait --timeout 6m
kubectl -n "$NS" get deploy "$RELEASE-grad-api" -o jsonpath='{.spec.template.spec.containers[0].env}' | grep -q MAX_ATTEMPTS
kubectl -n "$NS" rollout status deploy/"$RELEASE-grad-api" --timeout 180s
test "$(helm -n "$NS" history "$RELEASE" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["status"])')" = deployed

step "helm uninstall"
helm uninstall "$RELEASE" -n "$NS" --wait --timeout 3m
# Workers drain on SIGTERM (terminationGracePeriodSeconds) before their pods go.
kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/instance=$RELEASE --timeout 120s
left=$(kubectl -n "$NS" get all,serviceaccount,pdb,job,networkpolicy -l app.kubernetes.io/instance=$RELEASE -o name)
[ -z "$left" ] || { echo "FAIL: left behind: $left" >&2; exit 1; }
echo "helm smoke test passed"
