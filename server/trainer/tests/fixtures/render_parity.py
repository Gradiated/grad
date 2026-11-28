"""Writes render_parity.json: chats -> render_chat() text and trained text, and records ->
prompt_messages() / prompt_key(). server/api/test/trainer-parity.test.ts replays it against
renderMessages and the planner's prompt groups; run this after changing either rule."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from grad_trainer.errors import RecipeDataError  # noqa: E402
from grad_trainer.recipes.data import prompt_key, prompt_messages  # noqa: E402
from grad_trainer.templates import render_chat  # noqa: E402

U = {"role": "user", "content": "What is 2+2?"}
U2 = {"role": "user", "content": "And 3+3?"}
SYS = {"role": "system", "content": "Be brief."}
CALL = {"id": "c1", "type": "function", "function": {"name": "add", "arguments": {"a": 2, "b": 2}}}
TOOL = {"role": "tool", "tool_call_id": "c1", "content": "4"}
TOOLS = [{"type": "function", "function": {"name": "add", "parameters": {"type": "object"}}}]


def a(content, **kw):
    return {"role": "assistant", "content": content, **kw}


AUTO = {"train_on": "last", "thinking": "auto", "preserve_thinking": False}
chats = [
    ("a plain answer gets an empty think block", [U, a("4")], AUTO),
    ("a system prompt and two turns: earlier reasoning is dropped", [SYS, U, a("<think>add</think>4"), U2, a("<think>\nadd again\n</think>\n\n6")], AUTO),
    ("all_assistant with preserve_thinking keeps and trains both", [U, a("<think>add</think>4"), U2, a("<think>more</think>6")], {**AUTO, "train_on": "all_assistant", "preserve_thinking": True}),
    ("reasoning_content is reasoning", [U, a("4", reasoning_content="2 and 2")], {**AUTO, "thinking": "on"}),
    ("a bare </think> is reasoning", [U, a("adding\n</think>\n\n4")], {**AUTO, "thinking": "on"}),
    ("an empty think block is no reasoning", [U, a("<think>\n\n</think>\n\n4")], {**AUTO, "thinking": "off"}),
    ("an empty think block fails thinking=on", [U, a("<think></think>4")], {**AUTO, "thinking": "on"}),
    ("reasoning fails thinking=off", [U, a("4", reasoning_content="sum")], {**AUTO, "thinking": "off"}),
    ("an untrained turn's reasoning is no conflict", [U, a("<think>x</think>4", train=False), U2, a("6")], {**AUTO, "thinking": "off"}),
    ("train on a user turn is an error", [{**U, "train": True}, a("4")], AUTO),
    ("train=false on the last answer, train=true on an earlier one", [U, a("4", train=True), U2, a("6", train=False)], AUTO),
    ("a tool call, its result and the answer after it keep their reasoning", [U, a("<think>call add</think>", tool_calls=[CALL]), TOOL, {**TOOL, "content": "also 4"}, a("<think>got it</think>It is 4.")], AUTO),
    ("tools go in the system prompt", [SYS, U, a("", tool_calls=[CALL, {"name": "noop", "arguments": "{}"}]), TOOL, a("4")], {**AUTO, "tools": TOOLS}),
    ("tools without a system prompt", [U, a("4")], {**AUTO, "tools": TOOLS}),
    ("content parts and a trailing user turn", [{"role": "user", "content": [{"type": "text", "text": "hi "}, {"type": "text", "text": "there"}]}, a("hello"), U2], AUTO),
    ("unicode", [{"role": "user", "content": "Grüße, 東京?"}, a("<think>ü</think>Tōkyō")], AUTO),
]
render = []
for name, messages, opts in chats:
    opts = dict(opts)
    tools = opts.pop("tools", None)
    try:
        r = render_chat(messages, tools=tools, **opts)
        expected = {"text": r.text, "trained_text": r.trained_text}
    except RecipeDataError:
        expected = {"error": True}
    render.append({"name": name, "messages": messages, "tools": tools, "options": opts, **expected})

records = [
    ("chat messages", {"messages": [U, a("4")]}),
    ("a trailing user turn is part of the prompt", {"messages": [U, a("4"), U2]}),
    ("several trailing assistant turns", {"messages": [U, a("4"), a("Anything else?")]}),
    ("a tool-call trajectory", {"schema": "grad.trajectory/1", "input": {"messages": [SYS, U]}, "output": {"turns": [a("", tool_calls=[CALL]), TOOL, a("4")]}}),
    ("messages win over input.messages", {"messages": [U2, a("6")], "input": {"messages": [U]}, "output": {"turns": [a("4")]}}),
    ("prompt and completion", {"prompt": "What is 2+2?", "completion": "4"}),
    ("prompt as messages", {"prompt": [SYS, U], "completion": [a("4")]}),
    ("a group_id wins", {"group_id": "g1", "messages": [U, a("4")]}),
    ("only a system prompt", {"messages": [SYS, a("hi")]}),
    ("no prompt", {"messages": [a("4")]}),
    ("unicode", {"messages": [{"role": "user", "content": "Grüße, 東京?"}, a("x")]}),
]
prompts = [{"name": n, "record": r, "prompt": prompt_messages(r), "key": prompt_key(r)} for n, r in records]

Path(__file__).with_name("render_parity.json").write_text(
    json.dumps({"render": render, "prompts": prompts}, indent=1, ensure_ascii=False) + "\n"
)
