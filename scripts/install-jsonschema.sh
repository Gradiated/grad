#!/usr/bin/env sh
# Installs the reference worker's one dependency, jsonschema, hash-pinned:
# its entries (and its dependencies') are taken from the trainer's CPU lock,
# so the two never drift. Usage: scripts/install-jsonschema.sh [python]
set -eu
python=${1:-python3}
lock="$(dirname "$0")/../server/trainer/requirements-cpu.lock"
reqs=$(mktemp)
trap 'rm -f "$reqs"' EXIT
awk '/^[a-z]/ { keep = ($1 ~ /^(attrs|jsonschema|jsonschema-specifications|referencing|rpds-py|typing-extensions)==/) } keep' "$lock" > "$reqs"
"$python" -m pip install --require-hashes --no-deps -r "$reqs"
