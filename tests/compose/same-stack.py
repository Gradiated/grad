"""server/docker-compose.yml (`grad local up --build`) and the CLI's embedded
cli/assets/docker-compose.yml (`grad local up`) must describe the same stack:
the same services, ports, limits, healthchecks and environment, except that
one builds images and the other pulls them. Usage: python3 same-stack.py"""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Intentional differences: plain `docker compose up` on a checkout defaults to
# AUTH_MODE=none (grad local up passes api_key), and the paths are relative.
IGNORED_ENV = {"AUTH_MODE", "AUTH_MODE_NONE_ALLOW_REMOTE"}


def services(path: str) -> dict:
    out = subprocess.run(
        ["docker", "compose", "-f", str(ROOT / path), "--profile", "*", "config", "--format", "json", "--no-interpolate"],
        check=True, capture_output=True, text=True,
    ).stdout
    result = {}
    for name, svc in json.loads(out)["services"].items():
        svc.pop("build", None)
        svc.pop("image", None)
        env = svc.get("environment") or {}
        for key in IGNORED_ENV:
            env.pop(key, None)
        svc.pop("volumes", None) if name == "grafana" else None
        result[name] = svc
    return result


built, embedded = services("server/docker-compose.yml"), services("cli/assets/docker-compose.yml")
diffs = []
for name in sorted(set(built) | set(embedded)):
    a, b = built.get(name), embedded.get(name)
    if a is None or b is None:
        diffs.append(f"service {name} only in {'cli/assets' if a is None else 'server'}/docker-compose.yml")
        continue
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            diffs.append(f"{name}.{key}:\n  server:     {json.dumps(a.get(key), sort_keys=True)}\n  cli/assets: {json.dumps(b.get(key), sort_keys=True)}")
if diffs:
    print("The two compose files drifted apart:\n" + "\n".join(diffs))
    sys.exit(1)
print(f"ok: {len(built)} services match")
