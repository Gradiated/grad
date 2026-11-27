"""GPU smoke test: RewardModelRecipe on a real Qwen3 model for a few steps.

Pairs are arithmetic questions with the correct answer (chosen) and an off-by-some answer
(rejected), so a working reward head separates them quickly. Checks that the run completes,
held-out pair accuracy beats chance, and the reward_bundle loads with the reference loader in
docs/ARTIFACT_FORMATS.md (plain transformers + peft + safetensors) and scores a correct answer
above a wrong one.

    PYTHONPATH=server/trainer python scripts/gpu-smoke/reward.py [--model qwen/qwen3-0.6b]
"""

from __future__ import annotations

import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _smoke import parser, record_count, report, run  # noqa: E402

DOC = Path(__file__).resolve().parents[2] / "docs" / "ARTIFACT_FORMATS.md"


def pairs(n: int, seed: int) -> list[dict]:
    """Arithmetic questions: the correct sum is chosen, a wrong one rejected."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        a, b = rng.randint(10, 99), rng.randint(10, 99)
        wrong = a + b + rng.choice([-11, -3, 2, 7, 10])
        out.append({"id": f"q{seed}-{i}", "prompt": f"What is {a} + {b}?", "chosen": f"{a} + {b} = {a + b}.", "rejected": f"{a} + {b} = {wrong}."})
    return out


def reference_loader() -> dict:
    """The doc's `common`, `backbone` and `reward_bundle` loader blocks, run as written."""
    blocks = dict(re.findall(r"```python\n# loader: (\S+)\n(.*?)```", DOC.read_text(), re.S))
    ns: dict = {"__name__": "artifact_formats_doc"}
    for name in ("common", "backbone", "reward_bundle"):
        exec(compile(blocks[name], f"{DOC.name}#{name}", "exec"), ns)
    return ns


def main() -> None:
    p = parser(__doc__.splitlines()[0])
    p.add_argument("--model", default="qwen/qwen3-0.6b")
    args = p.parse_args()

    config = {"model": args.model, "adapter": {"kind": "lora", "rank": 16, "alpha": 32}}
    result = run("reward", config, pairs(record_count(args), seed=1), args)
    summary, eval_report = result["summary"], result["summary"]["eval_report"]

    import torch

    ns = reference_loader()
    model = ns["RewardModel"](result["bundle_dir"], dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32)
    question = [{"role": "user", "content": "What is 41 + 26?"}]
    good = model.score([*question, {"role": "assistant", "content": "41 + 26 = 67."}])
    bad = model.score([*question, {"role": "assistant", "content": "41 + 26 = 74."}])
    summary["reference_loader_scores"] = {"correct": good, "wrong": bad}
    report(
        summary,
        {
            "completed": summary["status"] == "completed",
            "reward_bundle": summary["format"] == "reward_bundle",
            "pair_accuracy_above_chance": (eval_report.get("preference_accuracy") or 0) > 0.5,
            "loader_prefers_correct": good > bad,
        },
    )


if __name__ == "__main__":
    main()
