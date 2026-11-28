#!/usr/bin/env bash
# The chart's PrometheusRule against Prometheus itself: renders it, then
# `promtool check rules` and the unit tests in alerts.test.yml (series in,
# alerts and their summaries out). Needs helm and docker.
#
#   tests/helm/alerts.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PROMETHEUS=prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
chmod 755 "$WORK"  # promtool runs as nobody

# Release g in namespace t: the rules select namespace="t", service="g-grad-api".
helm template g "$ROOT/server/helm/grad" -n t --set storage.s3Bucket=b --set secrets.databaseUrl=postgres://x \
  --set metrics.prometheusRule.enabled=true -s templates/prometheusrule.yaml \
  | sed -n '/^spec:/,$p' | tail -n +2 | sed 's/^  //' > "$WORK/alerts.yml"
# runbook_url points at the chart's release tag.
version=$(sed -n 's/^appVersion: "\(.*\)"$/\1/p' "$ROOT/server/helm/grad/Chart.yaml")
sed "s/@APP_VERSION@/$version/g" "$ROOT/tests/helm/alerts.test.yml" > "$WORK/alerts.test.yml"
docker run --rm --entrypoint promtool -v "$WORK:/w:ro" -w /w "$PROMETHEUS" check rules alerts.yml
docker run --rm --entrypoint promtool -v "$WORK:/w:ro" -w /w "$PROMETHEUS" test rules alerts.test.yml
