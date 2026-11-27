"""Tests for all 7 Tier-1 trace connectors and auto-detection."""

from __future__ import annotations

import unittest

from grad_trainer.connectors import detect_source, normalize_traces


class ConnectorTests(unittest.TestCase):
    def test_all_seven_connectors_auto_detect_and_normalize(self) -> None:
        samples = [
            (
                "grad_trajectories",
                {
                    "id": "g1",
                    "session_id": "s1",
                    "messages": [
                        {"role": "user", "content": "hi"},
                        {"role": "assistant", "content": "hello"},
                    ],
                    "scores": {"helpful": 1.0},
                },
            ),
            (
                "gradiated",
                {
                    "id": "prx1",
                    "trace_id": "tr_1",
                    "model": "qwen/qwen3-8b",
                    "request": {"messages": [{"role": "user", "content": "ping"}]},
                    "response": {
                        "choices": [
                            {"message": {"role": "assistant", "content": "pong"}}
                        ]
                    },
                },
            ),
            (
                "otel",
                {
                    "span_id": "sp1",
                    "trace_id": "ot1",
                    "attributes": {
                        "gen_ai.request.model": "qwen/qwen3-8b",
                        "gen_ai.prompt.0.role": "user",
                        "gen_ai.prompt.0.content": "2+2?",
                        "gen_ai.completion.0.role": "assistant",
                        "gen_ai.completion.0.content": "4",
                    },
                },
            ),
            (
                "langfuse",
                {
                    "id": "lf1",
                    "sessionId": "lf_sess",
                    "input": [{"role": "user", "content": "summarize"}],
                    "output": "short summary",
                    "scores": [{"name": "quality", "value": 0.9}],
                },
            ),
            (
                "posthog",
                {
                    "uuid": "ph1",
                    "event": "$ai_generation",
                    "properties": {
                        "$ai_trace_id": "ph_tr",
                        "$ai_model": "gpt-4o-mini",
                        "$ai_input": [{"role": "user", "content": "help"}],
                        "$ai_output_choices": [
                            {"role": "assistant", "content": "sure"}
                        ],
                    },
                },
            ),
            (
                "braintrust",
                {
                    "id": "bt1",
                    "root_span_id": "bt_root",
                    "input": "translate hello",
                    "output": "bonjour",
                    "expected": "bonjour",
                    "scores": {"exact": 1.0},
                },
            ),
            (
                "langsmith",
                {
                    "id": "ls1",
                    "session_id": "ls_sess",
                    "inputs": {"messages": [{"role": "user", "content": "sql?"}]},
                    "outputs": {
                        "generations": [[{"text": "SELECT 1;"}]]
                    },
                    "feedback_stats": {"correctness": {"avg": 1.0}},
                },
            ),
        ]

        for expected_source, row in samples:
            self.assertEqual(detect_source(row), expected_source)
            normalized = normalize_traces([row], source="auto")
            self.assertEqual(len(normalized), 1, expected_source)
            msgs = normalized[0]["messages"]
            self.assertGreaterEqual(len(msgs), 2, expected_source)
            self.assertEqual(msgs[0]["role"], "user")
            self.assertEqual(msgs[-1]["role"], "assistant")


if __name__ == "__main__":
    unittest.main()
