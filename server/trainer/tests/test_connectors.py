"""Tests for all 7 Tier-1 trace connectors and auto-detection."""

from __future__ import annotations

import unittest

from grad_trainer.connectors import detect_source, normalize_traces, normalize_traces_with_stats, parse_row


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


class ConnectorEdgeCaseTests(unittest.TestCase):
    def test_openinference_and_otlp_list_attributes(self) -> None:
        openinference = {
            "span_id": "s",
            "attributes": {
                "llm.model_name": "gpt-x",
                "llm.input_messages.0.message.role": "user",
                "llm.input_messages.0.message.content": "hi",
                "llm.output_messages.0.message.role": "assistant",
                "llm.output_messages.0.message.content": "hello",
            },
        }
        rec = normalize_traces([openinference])[0]
        self.assertEqual([m["content"] for m in rec["messages"]], ["hi", "hello"])
        self.assertEqual(rec["metadata"]["model"], "gpt-x")
        otlp = {
            "traceId": "t1",
            "spanId": "s1",
            "attributes": [
                {"key": "gen_ai.request.model", "value": {"stringValue": "m"}},
                {"key": "gen_ai.prompt.0.role", "value": {"stringValue": "user"}},
                {"key": "gen_ai.prompt.0.content", "value": {"stringValue": "q"}},
                {"key": "gen_ai.completion.0.content", "value": {"stringValue": "a"}},
                {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "3"}},
                {"key": "tags", "value": {"arrayValue": {"values": [{"stringValue": "x"}]}}},
            ],
        }
        self.assertEqual(detect_source(otlp), "otel")
        rec = normalize_traces([otlp])[0]
        self.assertEqual((rec["session_id"], rec["id"]), ("t1", "s1"))
        self.assertEqual(rec["messages"][1], {"role": "assistant", "content": "a"})

    def test_genai_semconv_json_messages(self) -> None:
        row = {
            "attributes": {
                "gen_ai.input.messages": '[{"role": "user", "parts": [{"type": "text", "content": "q"}]}]',
                "gen_ai.output.messages": [{"role": "assistant", "content": "a"}],
                "gen_ai.conversation.id": "c1",
            }
        }
        rec = normalize_traces([row])[0]
        self.assertEqual([m["content"] for m in rec["messages"]], ["q", "a"])
        self.assertEqual(rec["session_id"], "c1")
        plain = {"attributes": {"gen_ai.input.messages": "just text"}}
        self.assertEqual(normalize_traces([plain])[0]["messages"], [{"role": "user", "content": "just text"}])

    def test_tool_calls_and_anthropic_blocks_are_kept(self) -> None:
        call = [{"id": "c", "type": "function", "function": {"name": "f", "arguments": "{}"}}]
        row = {
            "request": {"messages": [{"role": "user", "content": "go"}], "tools": [{"type": "function"}]},
            "response": {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": call}}]},
        }
        rec = normalize_traces([row])[0]
        self.assertEqual(rec["messages"][1]["tool_calls"], call)
        self.assertEqual(rec["tools"], [{"type": "function"}])
        anthropic = {
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "q"}]},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "f", "input": {"a": 1}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "res"}]},
            ]
        }
        msgs = normalize_traces([anthropic])[0]["messages"]
        self.assertEqual(msgs[1]["tool_calls"][0]["function"], {"name": "f", "arguments": {"a": 1}})
        self.assertEqual((msgs[2]["role"], msgs[2]["content"]), ("tool", "res"))

    def test_native_records_pass_through(self) -> None:
        rows = [
            {"prompt": "p", "chosen": "c", "rejected": "r", "group_id": 7},
            {"query": "q", "positive": "d", "negatives": ["n"]},
            {"state": {"t": 1}, "questions": {"x": {"type": "noul"}}, "expected_output": {"x": 1}},
            {"schema": "grad.trajectory/1", "group_id": "g", "role": "chosen", "input": {"messages": []}, "output": {"turns": []}},
        ]
        recs = normalize_traces(rows)
        self.assertEqual(len(recs), 4)
        self.assertEqual(recs[0]["group_id"], "7")
        self.assertEqual(recs[3]["schema"], "grad.trajectory/1")

    def test_detection_edge_cases_and_skip_stats(self) -> None:
        self.assertEqual(detect_source({"root_span_id": "r", "input": "x", "output": "y"}), "braintrust")
        self.assertEqual(detect_source({"traceId": "t", "input": "x"}), "langfuse")
        self.assertEqual(detect_source({"$ai_input": []}), "posthog")
        records, skipped = normalize_traces_with_stats(["text", {"messages": []}, {"inputs": {}, "outputs": {}}])
        self.assertEqual(records, [])
        self.assertEqual(skipped, {"not_an_object": 1, "grad_trajectories:no_messages": 1, "langsmith:no_messages": 1})
        with self.assertRaisesRegex(ValueError, "Unknown trace connector"):
            parse_row({}, "splunk")
        deep: dict = {"role": "user", "content": "x"}
        for _ in range(20):
            deep = {"message": deep}
        self.assertEqual(normalize_traces([{"input": deep, "output": "y"}])[0]["messages"], [{"role": "assistant", "content": "y"}])
        flat = {"inputs": {"q": 1}, "outputs": {"generations": [{"text": "a"}]}}
        self.assertEqual(normalize_traces([flat], source="langsmith")[0]["messages"][-1]["content"], "a")
        scores = normalize_traces([{"messages": [{"role": "user", "content": "x"}], "scores": [{"name": "a", "value": 1}, {"name": "b", "value": True}]}])
        self.assertEqual(scores[0]["scores"], {"a": 1.0})


if __name__ == "__main__":
    unittest.main()
