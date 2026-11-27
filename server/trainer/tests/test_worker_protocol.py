"""Worker protocol v1 tests against an in-process fake grad-server."""

from __future__ import annotations

import contextlib
import io
import json
import os
import signal
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from fixtures.fake_protocol_server import FakeProtocolServer
from fixtures.stub_runners import StubImporter, StubRunner

from grad_trainer.bundles import bundle_directory, extract_bundle
from grad_trainer.worker import (
    ProtocolClient,
    ServerError,
    TrainerWorker,
    WorkerAuthError,
)

KEY = "grad_worker_key"


def train_job(
    job_id: str = "run_1",
    *,
    attempt: int = 1,
    dataset_url: str = "/v1/trainer-jobs/run_1/dataset",
    resume: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": job_id,
        "kind": "train",
        "attempt": attempt,
        "lease_seconds": 60,
        "lease_expires_at": "2026-11-27T12:01:00Z",
        "run": {
            "id": job_id,
            "workspace_id": "ws",
            "name": "demo",
            "recipe_kind": "sft",
            "resolved_config": {"recipe_kind": "sft", "lr": 0.001},
            "total_steps": 3,
        },
        "import": None,
        "price_per_million_tokens": 0.4,
        "max_cost_usd": 2.5,
        "dataset": {"version": 1, "record_count": 2, "download_url": dataset_url},
        "resume": resume,
    }


def import_job(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "imp_1",
        "kind": "import",
        "attempt": 1,
        "lease_seconds": 60,
        "lease_expires_at": "2026-11-27T12:01:00Z",
        "run": None,
        "import": {
            "id": "imp_1",
            "workspace_id": "ws",
            "dataset": "d",
            "source": source,
            "connector": "auto",
        },
        "price_per_million_tokens": None,
        "max_cost_usd": None,
        "dataset": None,
        "resume": None,
    }


DATASET = b'{"messages":[{"role":"user","content":"hi"}]}\n{"messages":[{"role":"user","content":"yo"}]}\n'


class WorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)

    def server(self, **kwargs: Any) -> FakeProtocolServer:
        srv = FakeProtocolServer(api_key=KEY, **kwargs)
        srv.blobs.setdefault("/v1/trainer-jobs/run_1/dataset", DATASET)
        srv.__enter__()
        self.addCleanup(srv.__exit__)
        return srv

    def worker(
        self,
        srv: FakeProtocolServer,
        runner: Any = None,
        importer: Any = None,
        **kwargs: Any,
    ) -> TrainerWorker:
        client = ProtocolClient(srv.base_url, KEY, retry_base_s=0.01, retry_cap_s=0.02)
        return TrainerWorker(
            server_url=srv.base_url,
            worker_id="w-test",
            workdir=self.tmp.name,
            recipe_runner_factory=lambda _kind: runner or StubRunner(),
            import_runner=importer,
            recipes=["sft"],
            heartbeat_interval_s=kwargs.pop("heartbeat_interval_s", 0.05),
            client=client,
            **kwargs,
        )

    def test_happy_path_train(self) -> None:
        srv = self.server(jobs=[train_job()])
        runner = StubRunner()
        result = self.worker(srv, runner).run_once()
        self.assertEqual(result["status"], "completed")

        claim = srv.bodies("claim")[0]
        self.assertEqual(
            claim,
            {
                "worker_id": "w-test",
                "lease_seconds": 180,
                "kinds": ["train", "import"],
                "recipes": ["sft"],
            },
        )
        call = runner.calls[0]
        self.assertEqual(len(call["records"]), 2)
        self.assertEqual(call["budget"].max_cost_usd, 2.5)
        self.assertEqual(call["budget"].price_per_million_tokens, 0.4)
        self.assertIsNone(call["resume"])

        progress = srv.bodies("progress")
        self.assertEqual([p["metric"]["step"] for p in progress], [1, 2, 3])
        self.assertTrue(
            all(p["attempt"] == 1 and "timestamp" in p["metric"] for p in progress)
        )

        uploads = srv.bodies("uploads")
        self.assertEqual([u["kind"] for u in uploads], ["checkpoint", "artifact"])
        puts = [r for r in srv.requests if r.method == "PUT"]
        self.assertEqual(puts[0].headers["x-amz-checksum-sha256"], "abc")
        for u, put in zip(uploads, puts):
            self.assertEqual(len(put.body), u["size_bytes"])

        ckpt = srv.bodies("checkpoints")[0]
        self.assertEqual(
            (ckpt["step"], ckpt["upload_id"], ckpt["format"]), (2, "upl_1", "peft_lora")
        )

        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "completed")
        self.assertEqual(complete["upload_id"], "upl_2")
        self.assertEqual(complete["format"], "peft_lora")
        self.assertEqual(
            complete["tokens_processed"], 300
        )  # max(reported 150, metered 300)
        self.assertEqual(complete["eval_report"], {"eval_loss": 0.1})

        bundle = Path(self.tmp.name) / "artifact.tgz"
        bundle.write_bytes(srv.uploads["upl_2"])
        manifest = extract_bundle(bundle, Path(self.tmp.name) / "x")
        self.assertEqual(manifest["format"], "peft_lora")
        self.assertIn("adapter_model.safetensors", manifest["files"])
        self.assertIn("eval_report_sha256", manifest)

    def test_resume_downloads_and_extracts_checkpoint(self) -> None:
        src = Path(self.tmp.name) / "ckpt"
        src.mkdir()
        (src / "optimizer.pt").write_bytes(b"opt")
        archive = Path(self.tmp.name) / "ckpt.tgz"
        bundle_directory(src, archive, manifest={"kind": "checkpoint"})
        srv = self.server(
            jobs=[
                train_job(
                    attempt=2,
                    resume={
                        "checkpoint_id": "ckpt_9",
                        "step": 10,
                        "download_url": "/blobs/objects?key=ck",
                    },
                )
            ]
        )
        srv.blobs["/blobs/objects"] = archive.read_bytes()
        runner = StubRunner(checkpoint_at=None)
        self.worker(srv, runner).run_once()
        call = runner.calls[0]
        self.assertEqual(call["resume"].step, 10)
        self.assertEqual(call["resume_files"], ["manifest.json", "optimizer.pt"])
        self.assertEqual(srv.bodies("progress")[0]["metric"]["step"], 11)
        self.assertEqual(srv.bodies("complete")[0]["attempt"], 2)

    def test_cancel_from_progress_completes_cancelled_without_upload(self) -> None:
        srv = self.server(
            jobs=[train_job()],
            progress_reply=lambda n: {
                "should_stop": n >= 2,
                "stop_reason": "cancelled",
                "status": "cancelled",
            },
        )
        self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "cancelled")
        self.assertNotIn("upload_id", complete)
        self.assertEqual(complete["tokens_processed"], 200)
        self.assertEqual(srv.bodies("uploads"), [])

    def test_budget_stop_maps_to_stopped_budget_and_uploads(self) -> None:
        srv = self.server(
            jobs=[train_job()],
            progress_reply=lambda n: {"should_stop": n >= 0, "stop_reason": "budget"},
        )
        self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "stopped_budget")
        self.assertIn("upload_id", complete)

    def test_heartbeat_should_stop_cancels(self) -> None:
        srv = self.server(
            jobs=[train_job()],
            heartbeat_reply=lambda n: (
                200,
                {
                    "status": "cancelled",
                    "should_stop": True,
                    "stop_reason": "cancelled",
                    "lease_expires_at": "x",
                },
            ),
        )
        self.worker(
            srv, StubRunner(steps=200, checkpoint_at=None, step_sleep=0.02)
        ).run_once()
        self.assertEqual(srv.bodies("complete")[0]["status"], "cancelled")
        self.assertLess(len(srv.bodies("progress")), 200)

    def test_lease_lost_on_heartbeat_never_completes(self) -> None:
        srv = self.server(jobs=[train_job()], heartbeat_reply=lambda n: (409, {}))
        result = self.worker(
            srv, StubRunner(steps=200, checkpoint_at=None, step_sleep=0.02)
        ).run_once()
        self.assertEqual(result, {"job_id": "run_1", "status": "lease_lost"})
        self.assertEqual(srv.bodies("complete"), [])

    def test_runner_exception_completes_failed_with_tokens(self) -> None:
        srv = self.server(jobs=[train_job()])
        self.worker(srv, StubRunner(raise_at=3, checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "failed")
        self.assertIn("CUDA out of memory", complete["error"])
        self.assertEqual(complete["tokens_processed"], 200)

    def test_unknown_recipe_completes_failed(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(srv)

        def factory(kind: str) -> Any:
            raise ValueError(f"Unsupported recipe kind '{kind}'")

        worker.recipe_runner_factory = factory
        worker.run_once()
        self.assertIn("Unsupported recipe kind", srv.bodies("complete")[0]["error"])

    def test_checkpoint_conflict_is_ignored(self) -> None:
        srv = self.server(jobs=[train_job()], checkpoint_status=409)
        result = self.worker(srv).run_once()
        self.assertEqual(result["status"], "completed")

    def test_transient_errors_are_retried(self) -> None:
        srv = self.server(
            jobs=[train_job()], fail_next={"claim": [503], "complete": [503, 502]}
        )
        result = self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(srv.calls("complete")), 3)

    def test_sigterm_abandons_running_job(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(
            srv,
            StubRunner(steps=500, checkpoint_at=None, step_sleep=0.01),
            poll_interval_s=0.01,
        )
        previous = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGTERM, previous[0])
        self.addCleanup(signal.signal, signal.SIGINT, previous[1])
        timer = threading.Timer(0.3, os.kill, (os.getpid(), signal.SIGTERM))
        timer.start()
        self.assertEqual(worker.serve_forever(), 0)
        timer.cancel()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "abandoned")
        self.assertEqual(len(srv.calls("claim")), 1)

    def test_auth_failure_exits_with_clear_message(self) -> None:
        srv = self.server()
        srv.api_key = "other-key"
        worker = self.worker(srv)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = worker.serve_forever()
        self.assertEqual(code, 2)
        self.assertIn("rejected the worker key (HTTP 401", stderr.getvalue())
        self.assertIn("TRAINER_API_KEY", stderr.getvalue())
        with self.assertRaises(WorkerAuthError):
            worker.claim()

    def test_unreachable_server_is_reported(self) -> None:
        worker = TrainerWorker(
            server_url="http://127.0.0.1:9",
            client=ProtocolClient(
                "http://127.0.0.1:9", KEY, retry_base_s=0.001, retry_cap_s=0.001
            ),
            recipes=["sft"],
            poll_interval_s=0.01,
        )
        stderr = io.StringIO()
        threading.Timer(0.2, worker.request_shutdown).start()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(worker.serve_forever(), 0)
        self.assertIn(
            "grad-server unreachable at http://127.0.0.1:9", stderr.getvalue()
        )

    def test_redirects_are_refused(self) -> None:
        other = self.server()
        srv = self.server(redirect_claim_to=f"{other.base_url}/v1/trainer-jobs/claim")
        with self.assertRaises(ServerError) as ctx:
            self.worker(srv).claim()
        self.assertEqual(ctx.exception.code, "redirect")
        self.assertEqual(other.requests, [])

    def test_foreign_origin_urls_get_no_authorization(self) -> None:
        storage = self.server()
        storage.blobs["/data.jsonl"] = DATASET
        srv = self.server(
            jobs=[train_job(dataset_url=f"{storage.base_url}/data.jsonl")],
            upload_origin=storage.base_url,
        )
        result = self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        self.assertEqual(result["status"], "completed")
        foreign = [r for r in storage.requests if r.method in ("GET", "PUT")]
        self.assertEqual({r.method for r in foreign}, {"GET", "PUT"})
        self.assertTrue(all("authorization" not in r.headers for r in foreign))
        self.assertTrue(
            all(r.headers.get("authorization") == f"Bearer {KEY}" for r in srv.requests)
        )

    def test_import_upload_job_posts_batches_and_summary(self) -> None:
        srv = self.server(
            jobs=[
                import_job(
                    {
                        "kind": "upload",
                        "upload_id": "upl_x",
                        "format": "jsonl",
                        "download_url": "/blobs/objects?key=raw",
                    }
                )
            ]
        )
        srv.blobs["/blobs/objects"] = b'{"a": 1}\n'
        importer = StubImporter(batches=2, batch_size=3)
        result = self.worker(srv, importer=importer).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(importer.sources[0]["kind"], "file")
        self.assertEqual(importer.sources[0]["format"], "jsonl")
        self.assertEqual(importer.sources[0]["content"], b'{"a": 1}\n')
        self.assertIsNone(importer.sources[0]["connector"])
        self.assertEqual([len(b["records"]) for b in srv.bodies("records")], [3, 3])
        complete = srv.bodies("complete")[0]
        self.assertEqual(
            complete["import_summary"],
            {
                "dropped_count": 1,
                "drop_reasons": ["line 4: invalid JSON (Expecting value)"],
            },
        )

    def test_import_hf_source_passes_through_and_chunks(self) -> None:
        hf = {
            "kind": "hf",
            "repo": "openai/gsm8k",
            "split": "train",
            "config": "main",
            "columns": {"prompt": "question"},
            "limit": 5,
        }
        srv = self.server(jobs=[import_job(hf)])
        importer = StubImporter(batches=1, batch_size=10_001)
        self.worker(srv, importer=importer).run_once()
        self.assertEqual(importer.sources[0]["repo"], "openai/gsm8k")
        self.assertEqual(
            [len(b["records"]) for b in srv.bodies("records")], [10_000, 1]
        )

    def test_import_without_runner_fails_clearly(self) -> None:
        srv = self.server(jobs=[import_job({"kind": "hf", "repo": "a/b"})])
        self.worker(srv, importer=lambda: None).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "failed")
        self.assertIn("no dataset import runner", complete["error"])

    def test_idle_claim_returns_none(self) -> None:
        srv = self.server()
        self.assertIsNone(self.worker(srv).run_once())
        self.assertEqual(json.loads(srv.calls("claim")[0].body)["worker_id"], "w-test")


if __name__ == "__main__":
    unittest.main()
