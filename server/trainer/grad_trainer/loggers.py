"""Experiment trackers for recipe ``loggers=`` (W&B and MLflow), spoken over their HTTP APIs.

The claim payload carries ``job["loggers"]``: the run's logger specs with the workspace secret
already resolved (``api_key``). A tracker that is unreachable, rejects the key or errors is
logged once and switched off; it never fails or slows the run (every call has a short timeout).

Tracker hosts are user-supplied and the requests carry the tenant's key, so they go through the
same client as source syncs (``providers.http.HttpClient``): https only (http to loopback or
``GRAD_SOURCES_EGRESS_ALLOW``), no private, link-local or metadata addresses, every redirect hop
re-checked, credentials never sent to another origin, proxy settings ignored.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
import uuid
from typing import Any, Callable

from .providers.http import HttpClient

TIMEOUT_S = 10.0
WANDB_DEFAULT_HOST = "https://api.wandb.ai"


class TrackerHTTPError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


def _client(base_url: str, headers: dict[str, str], secret: str | None) -> HttpClient:
    return HttpClient(
        base_url,
        headers=headers,
        secrets=(secret,) if secret else (),
        connect_timeout_s=TIMEOUT_S,
        read_timeout_s=TIMEOUT_S,
        response_timeout_s=TIMEOUT_S,
        max_response_bytes=4 * 1024 * 1024,
        max_attempts=1,
    )


def _request(client: HttpClient, method: str, path: str, body: Any, *, missing_ok: bool = False) -> Any:
    resp = client.request(method, path, body=body, check_status=False)
    if missing_ok and resp.status == 404:
        return None
    if resp.status >= 300:
        raise TrackerHTTPError(resp.status)
    return json.loads(resp.body) if resp.body else {}


def _numeric(metric: dict[str, Any]) -> dict[str, float]:
    """Flatten a metric point to ``{name: number}`` (nested eval metrics as ``eval/<name>``)."""
    out: dict[str, float] = {}
    for key, value in metric.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = float(value)
        elif isinstance(value, dict):
            for sub, inner in value.items():
                if isinstance(inner, (int, float)) and not isinstance(inner, bool):
                    out[f"{key}/{sub}"] = float(inner)
    out.pop("step", None)
    return out


class MLflowLogger:
    name = "mlflow"

    def __init__(self, spec: dict[str, Any], run: dict[str, Any]) -> None:
        key = spec.get("api_key")
        self.http = _client(str(spec["tracking_uri"]).rstrip("/"), {"Authorization": f"Bearer {key}"} if key else {}, key)
        experiment = str(spec.get("experiment") or run.get("name") or "grad")
        found = self._call("GET", "experiments/get-by-name?" + urllib.parse.urlencode({"experiment_name": experiment}), None, missing_ok=True)
        if found:
            experiment_id = found["experiment"]["experiment_id"]
        else:
            experiment_id = self._call("POST", "experiments/create", {"name": experiment})["experiment_id"]
        created = self._call(
            "POST",
            "runs/create",
            {
                "experiment_id": experiment_id,
                "run_name": str(spec.get("run_name") or run.get("name") or run.get("id")),
                "start_time": int(time.time() * 1000),
                "tags": [{"key": "grad.run_id", "value": str(run.get("id", ""))}],
            },
        )
        self.run_id = created["run"]["info"]["run_id"]
        params = [{"key": k, "value": str(v)[:500]} for k, v in _flat_params(run.get("config") or {}).items()][:100]
        if params:
            self._call("POST", "runs/log-batch", {"run_id": self.run_id, "params": params})

    def _call(self, method: str, path: str, body: Any, *, missing_ok: bool = False) -> Any:
        return _request(self.http, method, f"/api/2.0/mlflow/{path}", body, missing_ok=missing_ok)

    def log(self, step: int, metrics: dict[str, float]) -> None:
        now = int(time.time() * 1000)
        batch = [{"key": k, "value": v, "timestamp": now, "step": step} for k, v in metrics.items()]
        self._call("POST", "runs/log-batch", {"run_id": self.run_id, "metrics": batch})

    def finish(self, status: str) -> None:
        state = {"completed": "FINISHED", "stopped_budget": "FINISHED", "failed": "FAILED"}.get(status, "KILLED")
        self._call("POST", "runs/update", {"run_id": self.run_id, "status": state, "end_time": int(time.time() * 1000)})


class WandBLogger:
    """W&B over its public HTTP API: ``upsertBucket`` (GraphQL) creates the run and the
    file stream appends history rows, as the wandb client does."""

    name = "wandb"

    def __init__(self, spec: dict[str, Any], run: dict[str, Any]) -> None:
        host = str(spec.get("host") or WANDB_DEFAULT_HOST).rstrip("/")
        token = base64.b64encode(f"api:{spec['api_key']}".encode()).decode()
        self.http = _client(host, {"Authorization": f"Basic {token}"}, str(spec["api_key"]))
        self.project = str(spec["project"])
        self.entity = spec.get("entity") or self._graphql("query Viewer { viewer { entity } }", {})["viewer"]["entity"]
        self.run_name = uuid.uuid4().hex[:8]
        self._graphql(
            "mutation UpsertBucket($name: String, $project: String, $entity: String, $displayName: String, $config: JSONString) {"
            " upsertBucket(input: {name: $name, modelName: $project, entityName: $entity, displayName: $displayName, config: $config})"
            " { bucket { id name } } }",
            {
                "name": self.run_name,
                "project": self.project,
                "entity": self.entity,
                "displayName": str(spec.get("run_name") or run.get("name") or run.get("id")),
                "config": json.dumps({k: {"value": v} for k, v in (run.get("config") or {}).items()}, default=str),
            },
        )
        self.offset = 0
        self.stream = f"/files/{self.entity}/{self.project}/{self.run_name}/file_stream"

    def _graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        reply = _request(self.http, "POST", "/graphql", {"query": query, "variables": variables})
        if reply.get("errors"):
            raise RuntimeError(f"W&B rejected the request: {reply['errors'][0].get('message', reply['errors'][0])}")
        data: dict[str, Any] = reply.get("data") or {}
        return data

    def log(self, step: int, metrics: dict[str, float]) -> None:
        row = json.dumps({**metrics, "_step": step, "_timestamp": time.time()})
        _request(self.http, "POST", self.stream, {"files": {"wandb-history.jsonl": {"offset": self.offset, "content": [row]}}})
        self.offset += 1

    def finish(self, status: str) -> None:
        _request(self.http, "POST", self.stream, {"complete": True, "exitcode": 0 if status in ("completed", "stopped_budget") else 1})


KINDS: dict[str, Callable[[dict[str, Any], dict[str, Any]], Any]] = {"mlflow": MLflowLogger, "wandb": WandBLogger}


def _flat_params(config: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in config.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(_flat_params(value, f"{name}."))
        elif not isinstance(value, list):
            out[name] = value
    return out


class Loggers:
    """Fan-out to every configured tracker; a failing tracker is reported once and dropped."""

    def __init__(self, specs: list[dict[str, Any]], run: dict[str, Any], warn: Callable[[str], None]) -> None:
        self.warn = warn
        self.active: list[Any] = []
        for spec in specs:
            kind = str(spec.get("kind"))
            factory = KINDS.get(kind)
            if factory is None:
                warn(f"logger '{kind}' is not supported (wandb, mlflow); skipped")
                continue
            try:
                self.active.append(factory(spec, run))
            except Exception as exc:  # noqa: BLE001 - a tracker must never fail the run
                warn(f"logger '{kind}' disabled: could not start ({_describe(exc)})")

    def log(self, metric: dict[str, Any]) -> None:
        step = metric.get("step")
        values = _numeric(metric)
        if not isinstance(step, int) or not values:
            return
        self._each("log", step, values)

    def finish(self, status: str) -> None:
        self._each("finish", status)
        self.active = []

    def _each(self, method: str, *args: Any) -> None:
        for tracker in list(self.active):
            try:
                getattr(tracker, method)(*args)
            except Exception as exc:  # noqa: BLE001
                self.active.remove(tracker)
                self.warn(f"logger '{tracker.name}' disabled: {method} failed ({_describe(exc)})")


def _describe(exc: Exception) -> str:
    return str(exc)[:200] or type(exc).__name__
