"""Python SDK half of the compose smoke test (run by tests/compose/smoke.sh).

Uses the 'local' profile that `grad local up` wrote, so it exercises the
config-file fallback too. Trains on the tiny model with the CPU torch worker.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from grad import Grad, Rubric, Scorer, validators
from grad.recipes import SFTRecipe

LLM = "test/tiny-qwen3"
RECORDS = [
    {
        "messages": [
            {"role": "user", "content": f"List users with id {i}"},
            {"role": "assistant", "content": f"SELECT * FROM users WHERE id = {i};"},
        ]
    }
    for i in range(24)
]


def main() -> None:
    client = Grad(profile="local")
    dataset = client.datasets.push("sdk-smoke", RECORDS)
    recipe = SFTRecipe(model=LLM, batch_size=8)
    print(client.runs.plan(dataset=dataset, name="sdk-smoke", recipe=recipe))
    run = client.runs.create(dataset=dataset, name="sdk-smoke", recipe=recipe, max_cost_usd=5).wait(timeout=600)
    assert run.status == "completed", run.status
    with tempfile.TemporaryDirectory() as tmp:
        out = run.artifact.download(Path(tmp) / "sdk-smoke")
        assert (out / "adapter_config.json").is_file(), sorted(p.name for p in out.iterdir())
    rubric = Rubric([validators.NonEmpty(), Scorer("says_select", fn=lambda t: 1.0 if "select" in t.text.lower() else 0.0)])
    ev = client.evals.create(name="sdk-smoke", models=[run.artifact, LLM], dataset=dataset, rubric=rubric, limit=4).wait(timeout=300)
    assert ev.status == "completed", ev.status
    print(ev.summary_table())
    print("sdk smoke ok:", run.artifact.ref)


if __name__ == "__main__":
    sys.exit(main())
