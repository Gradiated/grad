"""Row -> record transforms for the built-in benchmarks (``datasets.from_benchmark``).

The server owns the curated list (repo, config, split, pinned revision and the rubric that
scores it: server/api/src/benchmarks.ts) and sends an ``hf`` import source with
``benchmark: <name>``. Each transform turns one Hugging Face row into a chat record whose
``expected_output`` is the answer the benchmark's validator compares against.
"""

from __future__ import annotations

from typing import Any, Callable

from .errors import SourceUnavailableError

LETTERS = "ABCDEFGHIJKLMNOP"

GSM8K_INSTRUCTION = "Solve the problem step by step. End with the final answer on its own line as '#### <number>'."
CHOICE_INSTRUCTION = "Answer with the letter of the correct option, for example 'Answer: B'."


def _record(rid: str, prompt: str, answer: str, **metadata: Any) -> dict[str, Any]:
    return {
        "id": rid,
        "messages": [{"role": "user", "content": prompt}],
        "expected_output": answer,
        "metadata": {k: v for k, v in metadata.items() if v is not None},
    }


def _choices(question: str, options: list[Any]) -> str:
    lines = [f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options)]
    return f"{question.strip()}\n\n" + "\n".join(lines) + f"\n\n{CHOICE_INSTRUCTION}"


def gsm8k(row: dict[str, Any], index: int) -> dict[str, Any]:
    answer = str(row["answer"]).rsplit("####", 1)[-1].strip().replace(",", "")
    return _record(f"gsm8k:{index}", f"{str(row['question']).strip()}\n\n{GSM8K_INSTRUCTION}", answer, benchmark="gsm8k")


def mmlu(row: dict[str, Any], index: int) -> dict[str, Any]:
    return _record(
        f"mmlu:{index}",
        _choices(str(row["question"]), list(row["choices"])),
        LETTERS[int(row["answer"])],
        benchmark="mmlu",
        subject=row.get("subject"),
    )


def mmlu_pro(row: dict[str, Any], index: int) -> dict[str, Any]:
    return _record(
        f"mmlu_pro:{row.get('question_id', index)}",
        _choices(str(row["question"]), list(row["options"])),
        str(row["answer"]).strip(),
        benchmark="mmlu_pro",
        category=row.get("category"),
    )


def arc_challenge(row: dict[str, Any], index: int) -> dict[str, Any]:
    choices = row["choices"]
    labels = [str(label) for label in choices["label"]]
    key = str(row["answerKey"]).strip()
    # A few ARC rows label options 1-4 instead of A-D; normalise to letters.
    answer = LETTERS[labels.index(key)] if key in labels else key
    return _record(
        f"arc_challenge:{row.get('id', index)}",
        _choices(str(row["question"]), list(choices["text"])),
        answer,
        benchmark="arc_challenge",
    )


TRANSFORMS: dict[str, Callable[[dict[str, Any], int], dict[str, Any]]] = {
    "gsm8k": gsm8k,
    "mmlu": mmlu,
    "mmlu_pro": mmlu_pro,
    "arc_challenge": arc_challenge,
}


def to_record(name: str, row: dict[str, Any], index: int) -> dict[str, Any]:
    transform = TRANSFORMS.get(name)
    if transform is None:
        raise SourceUnavailableError(f"Unknown benchmark '{name}' (known: {', '.join(sorted(TRANSFORMS))}).")
    try:
        return transform(row, index)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise SourceUnavailableError(
            f"Benchmark '{name}' row {index} doesn't have the expected columns ({exc!r}); "
            "the pinned revision may have changed upstream."
        ) from exc
