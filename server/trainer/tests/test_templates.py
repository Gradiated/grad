"""Chat template rendering, loss masks and parity with the upstream Qwen3 chat template."""

from __future__ import annotations

import unittest

from helpers import TorchCase

from grad_trainer.errors import RecipeConfigError, RecipeDataError
from grad_trainer.templates import message_text, render_chat, tokenize_rendered, tokenize_rendered_batch

MULTI_TURN = [
    {"role": "system", "content": "Be brief."},
    {"role": "user", "content": "First Q"},
    {"role": "assistant", "content": "<think>plan 1</think>First A"},
    {"role": "user", "content": "Second Q"},
    {"role": "assistant", "content": "<think>\nplan 2\n</think>\n\nSecond A"},
]
TOOLS = [{"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object"}}}]
TOOL_TRACE = [
    {"role": "user", "content": "Weather in Paris?"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"type": "function", "function": {"name": "get_weather", "arguments": {"city": "Paris"}}}],
    },
    {"role": "tool", "content": "sunny"},
    {"role": "tool", "content": "22C"},
    {"role": "assistant", "content": "Sunny and 22C.", "tool_calls": [{"name": "log", "arguments": "{\"ok\": true}"}]},
]


def trained(messages, **kwargs):
    return [s.text for s in render_chat(messages, **kwargs).segments if s.trained]


class RenderTests(unittest.TestCase):
    def test_last_turn_trains_reasoning_and_answer_only(self) -> None:
        self.assertEqual(trained(MULTI_TURN), ["<think>\nplan 2\n</think>\n\n", "Second A<|im_end|>"])
        text = render_chat(MULTI_TURN).text
        self.assertNotIn("plan 1", text)  # earlier reasoning stripped, as upstream
        self.assertTrue(text.startswith("<|im_start|>system\nBe brief.<|im_end|>\n"))

    def test_target_without_reasoning_masks_the_empty_think_block(self) -> None:
        msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
        rendered = render_chat(msgs)
        self.assertIn("<think>\n\n</think>\n\nhello", rendered.text)
        self.assertEqual(trained(msgs), ["hello<|im_end|>"])
        self.assertEqual(trained(msgs, thinking="off"), ["hello<|im_end|>"])

    def test_all_assistant_and_preserve_thinking(self) -> None:
        spans = trained(MULTI_TURN, train_on="all_assistant")
        self.assertEqual(spans[0], "First A<|im_end|>")
        kept = trained(MULTI_TURN, train_on="all_assistant", preserve_thinking=True)
        self.assertEqual(kept[0], "<think>\nplan 1\n</think>\n\n")

    def test_thinking_conflicts_fail_with_record_id(self) -> None:
        with self.assertRaisesRegex(RecipeDataError, "rec-9.*thinking='off'"):
            render_chat(MULTI_TURN, thinking="off", record_id="rec-9")
        with self.assertRaisesRegex(RecipeDataError, "thinking='on'"):
            render_chat([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}], thinking="on")
        with self.assertRaisesRegex(RecipeConfigError, "not supported"):
            render_chat(MULTI_TURN, thinking="high")

    def test_untrained_turns_are_not_validated(self) -> None:
        msgs = [*MULTI_TURN[:3], {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
        self.assertEqual(trained(msgs, thinking="off"), ["a<|im_end|>"])

    def test_tool_calls_and_tool_responses(self) -> None:
        rendered = render_chat(TOOL_TRACE, tools=TOOLS, train_on="all_assistant")
        spans = [s.text for s in rendered.segments if s.trained]
        self.assertEqual(
            spans[0], '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call><|im_end|>'
        )
        self.assertIn('Sunny and 22C.\n<tool_call>\n{"name": "log", "arguments": {"ok": true}}\n</tool_call>', spans[-1])
        self.assertIn("<|im_start|>user\n<tool_response>\nsunny\n</tool_response>\n<tool_response>\n22C\n</tool_response><|im_end|>", rendered.text)
        self.assertIn("# Tools", rendered.text)
        self.assertFalse(any("tool_response" in s for s in spans))

    def test_message_train_flag(self) -> None:
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1", "train": True},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "a2", "train": False},
        ]
        self.assertEqual(trained(msgs), ["a1<|im_end|>"])
        with self.assertRaisesRegex(RecipeDataError, "only assistant"):
            render_chat([{"role": "user", "content": "u", "train": True}])

    def test_invalid_inputs(self) -> None:
        with self.assertRaises(RecipeDataError):
            render_chat([])
        with self.assertRaises(RecipeDataError):
            render_chat([{"role": "robot", "content": "x"}])
        with self.assertRaises(RecipeConfigError):
            render_chat(MULTI_TURN, template_revision="bge@1")
        with self.assertRaises(RecipeDataError):
            render_chat([{"role": "assistant", "content": "", "tool_calls": ["bad"]}])

    def test_generation_prompt_and_helpers(self) -> None:
        rendered = render_chat([{"role": "user", "content": "q"}], add_generation_prompt=True, enable_thinking=False)
        self.assertTrue(rendered.text.endswith("<|im_start|>assistant\n<think>\n\n</think>\n\n"))
        self.assertEqual(rendered.trained_text, "")
        self.assertEqual(message_text([{"type": "text", "text": "a"}, "b", 3]), "ab")
        self.assertEqual(message_text(None), "")
        self.assertEqual(message_text(5), "5")


PARITY_CASES = [
    (MULTI_TURN, None, False),
    (TOOL_TRACE, TOOLS, False),
    ([{"role": "system", "content": "s"}, *TOOL_TRACE], TOOLS, False),
    (MULTI_TURN[:4], None, True),
    ([{"role": "user", "content": "<tool_response>\nx\n</tool_response>"}, {"role": "assistant", "content": "ok"}], None, False),
    ([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a", "reasoning_content": "r"}], None, False),
    ([{"role": "user", "content": "日本語 ✓"}, {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "f", "arguments": {"q": "ü"}}}]}], None, False),
]


class TemplateParityTests(TorchCase):
    """The pinned renderer must produce exactly what Qwen3's own chat_template renders."""

    def setUp(self) -> None:
        from transformers import AutoTokenizer

        from fixtures.tiny_models import ensure_tiny_models, QWEN_ID

        self.tok = AutoTokenizer.from_pretrained(str(ensure_tiny_models()[QWEN_ID]))

    def test_text_matches_upstream_template(self) -> None:
        for messages, tools, gen in PARITY_CASES:
            for enable_thinking in (True, False):
                with self.subTest(messages=messages, thinking=enable_thinking):
                    expected = self.tok.apply_chat_template(
                        messages, tools=tools, tokenize=False, add_generation_prompt=gen, enable_thinking=enable_thinking
                    )
                    ours = render_chat(
                        messages, tools=tools, add_generation_prompt=gen, enable_thinking=enable_thinking, train_on="last"
                    ).text
                    self.assertEqual(ours, expected)

    def test_trained_tokens_decode_to_trained_text(self) -> None:
        rendered = render_chat(MULTI_TURN, train_on="all_assistant")
        tok = tokenize_rendered(rendered, self.tok)
        ids = [i for i, t in zip(tok.input_ids, tok.trained) if t]
        self.assertEqual(self.tok.decode(ids), rendered.trained_text)
        self.assertEqual(list(tok.input_ids), self.tok(rendered.text, add_special_tokens=False)["input_ids"])
        short = tokenize_rendered(rendered, self.tok, max_len=5)
        self.assertTrue(short.truncated)
        self.assertEqual(len(short.input_ids), 5)
        self.assertEqual(short.num_trained, 0)
        # Compact storage: int32 ids and a bool mask (5 bytes a token).
        self.assertEqual((tok.input_ids.dtype.name, tok.trained.dtype.name), ("int32", "bool"))

    def test_a_batch_tokenizes_like_one_chat_at_a_time(self) -> None:
        chats = [render_chat(MULTI_TURN, train_on=t) for t in ("all_assistant", "last")]
        chats.append(render_chat([{"role": "user", "content": "q"}], add_generation_prompt=True))
        for one, batched in zip([tokenize_rendered(c, self.tok, max_len=40) for c in chats], tokenize_rendered_batch(chats, self.tok, max_len=40)):
            self.assertEqual((one.input_ids.tolist(), one.trained.tolist(), one.truncated), (batched.input_ids.tolist(), batched.trained.tolist(), batched.truncated))
        self.assertEqual(tokenize_rendered_batch([], self.tok), [])


if __name__ == "__main__":
    unittest.main()
