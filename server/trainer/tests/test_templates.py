"""Tests for chat template rendering and loss-mask parity."""

from __future__ import annotations

import unittest

from grad_trainer.templates import render_messages


class TemplateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.multi_turn = [
            {"role": "user", "content": "First Q"},
            {"role": "assistant", "content": "<think>plan 1</think>First A"},
            {"role": "user", "content": "Second Q"},
            {"role": "assistant", "content": "<think>plan 2</think>Second A"},
        ]

    def test_trains_last_assistant_and_strips_prior_thinking(self) -> None:
        rendered = render_messages(
            "rec_1",
            self.multi_turn,
            model="qwen/qwen3-8b",
            train_on="last",
            thinking="auto",
            preserve_thinking=False,
        )
        self.assertEqual(rendered.template_revision, "qwen3@3")
        trained = [s for s in rendered.spans if s.trained]
        self.assertEqual(len(trained), 1)
        self.assertIn("Second A", trained[0].text)
        self.assertNotIn("<think>plan 1</think>", rendered.full_text)

    def test_all_assistant_and_preserve_thinking(self) -> None:
        rendered = render_messages(
            "rec_2",
            self.multi_turn,
            train_on="all_assistant",
            thinking="on",
            preserve_thinking=True,
        )
        trained = [s for s in rendered.spans if s.trained]
        self.assertEqual(len(trained), 2)
        self.assertIn("<think>plan 1</think>", trained[0].text)

    def test_thinking_conflicts_fail_loudly(self) -> None:
        with self.assertRaisesRegex(ValueError, "thinking='off'"):
            render_messages("rec_3", self.multi_turn, thinking="off")

        with self.assertRaisesRegex(ValueError, "thinking='on'"):
            render_messages(
                "rec_4",
                [
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "no think tag"},
                ],
                thinking="on",
            )

    def test_per_message_train_override(self) -> None:
        rendered = render_messages(
            "rec_5",
            [
                {"role": "user", "content": "u1"},
                {"role": "assistant", "content": "a1", "train": True},
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2", "train": False},
            ],
            thinking="off",
        )
        trained = [s for s in rendered.spans if s.trained]
        self.assertEqual(len(trained), 1)
        self.assertIn("a1", trained[0].text)


if __name__ == "__main__":
    unittest.main()
