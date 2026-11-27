"""GPU smoke test: DistillRecipe on real Qwen3 models for a few steps.

On-policy (default): the Qwen3-0.6B student writes answers, the Qwen3-1.7B teacher (same
tokenizer) scores them with top-k KL. Checks that the run completes, the held-out KL to the
teacher drops below the untrained student's, metering stays within the reserved upper bound,
and the exported PEFT adapter loads on the base model and generates. ``--off-policy`` trains
on fixed teacher answers instead (generated here by the teacher, standing in for the labeling
eval the server runs through the inference endpoint).

    PYTHONPATH=server/trainer python scripts/gpu-smoke/distill.py [--student ...] [--teacher ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _smoke import parser, record_count, report, run  # noqa: E402

TOPICS = [
    "rotate an API key", "reset a password", "export invoices as CSV", "add a teammate", "enable two-factor login",
    "cancel a subscription", "change the billing email", "download usage reports", "set a spending limit", "delete a project",
    "restore a deleted file", "connect a Slack workspace", "rename a workspace", "create a webhook", "revoke a session",
    "change the default region", "invite an admin", "upgrade a plan", "pause notifications", "merge two accounts",
]


def prompts(n: int) -> list[dict]:
    return [
        {"id": f"p{i}", "messages": [{"role": "user", "content": f"In two sentences, how do I {TOPICS[i % len(TOPICS)]}? (case {i})"}]}
        for i in range(n)
    ]


def teacher_answers(records: list[dict], teacher: str, max_new_tokens: int) -> list[dict]:
    """Greedy teacher answers (what the server's labeling eval produces for off-policy runs)."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from grad_trainer.models import resolve_model

    path = str(resolve_model(teacher).path)
    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32)
    model.to("cuda" if torch.cuda.is_available() else "cpu").eval()
    out = []
    for rec in records:
        ids = tok.apply_chat_template(rec["messages"], add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True)
        ids = {k: v.to(model.device) for k, v in ids.items()}
        with torch.no_grad():
            gen = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=False)[0, ids["input_ids"].shape[1] :]
        answer = tok.decode(gen, skip_special_tokens=True).strip()
        out.append({**rec, "messages": [*rec["messages"], {"role": "assistant", "content": answer}]})
    del model
    return out


def main() -> None:
    p = parser(__doc__.splitlines()[0])
    p.add_argument("--student", default="qwen/qwen3-0.6b")
    p.add_argument("--teacher", default="qwen/qwen3-1.7b")
    p.add_argument("--max-new-tokens", type=int, default=64)
    p.add_argument("--top-k", type=int, default=32)
    p.add_argument("--off-policy", action="store_true")
    args = p.parse_args()

    records = prompts(record_count(args))
    rollout = {"kind": "off_policy" if args.off_policy else "on_policy", "max_new_tokens": args.max_new_tokens}
    params = {"teacher": args.teacher, "rollout": rollout, "teacher_token_weight": 2.0}
    if args.off_policy:
        params["loss"] = {"kind": "cross_entropy"}
        records = teacher_answers(records, args.teacher, args.max_new_tokens)
    else:
        params["loss"] = {"kind": "top_k_kl_distill", "top_k": args.top_k}
    config = {"model": args.student, "thinking": "off", "adapter": {"kind": "lora", "rank": 16, "alpha": 32}, "recipe_params": params}
    result = run("distill", config, records, args)
    summary, report_ = result["summary"], result["summary"]["eval_report"]

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from grad_trainer.models import resolve_model

    base_path = str(resolve_model(args.student).path)
    tok = AutoTokenizer.from_pretrained(base_path)
    base = AutoModelForCausalLM.from_pretrained(base_path, dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32)
    model = PeftModel.from_pretrained(base.to("cuda" if torch.cuda.is_available() else "cpu"), str(result["bundle_dir"])).eval()
    ids = tok.apply_chat_template(records[0]["messages"][:1], add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True)
    ids = {k: v.to(model.device) for k, v in ids.items()}
    with torch.no_grad():
        sample = tok.decode(model.generate(**ids, max_new_tokens=32, do_sample=False)[0, ids["input_ids"].shape[1] :], skip_special_tokens=True)
    summary["sample"] = sample

    checks = {"completed": summary["status"] == "completed", "peft_lora": summary["format"] == "peft_lora", "generates": bool(sample.strip())}
    if args.off_policy:
        checks["eval_loss_reported"] = report_.get("eval_loss") is not None
    else:
        checks["kl_dropped"] = report_["eval_kl"] is not None and report_["base_kl"] is not None and report_["eval_kl"] < report_["base_kl"]
        checks["answers_within_cap"] = (report_.get("mean_answer_tokens") or 0) <= args.max_new_tokens
    report(summary, checks)


if __name__ == "__main__":
    main()
