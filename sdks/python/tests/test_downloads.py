"""Artifact downloads: streamed SHA-256 verification, safe extraction, PEFT layout, atomic placement."""

from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from _fakes import Reply, bundle_bytes, fixture, json_reply, make_client

import grad
from grad._helpers import safe_extract_bundle

ART = fixture("python-artifact.json")
PEFT_FILES = {"adapter_config.json": b'{"peft_type": "LORA", "r": 32}', "adapter_model.safetensors": b"\x00" * 64, "README.md": b"# adapter"}


def artifact(bundle: bytes, fmt: str = "peft_lora", sha: str | None = None) -> dict:
    digest = sha or hashlib.sha256(bundle).hexdigest()
    return {**ART, "format": fmt, "sha256": digest, "size_bytes": len(bundle)}


def routes(bundle: bytes, *, fmt: str = "peft_lora", header_sha: str | None = None, declared: str | None = None, chunks: int = 3, error: BaseException | None = None) -> dict:
    meta = artifact(bundle, fmt, declared)
    ref = f"{meta['name']}@{meta['version']}"
    size = max(1, len(bundle) // chunks)
    parts = [bundle[i : i + size] for i in range(0, len(bundle), size)]
    headers = {"content-type": "application/octet-stream"}
    sha = header_sha if header_sha is not None else meta["sha256"]
    if sha:
        headers["x-artifact-sha256"] = sha
    return {
        f"GET /v1/artifacts/{ref}": json_reply(meta),
        f"GET /v1/artifacts/{ref}/download": Reply(200, headers=headers, chunks=parts, error=error),
    }


def leftovers(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.iterdir() if p.name.startswith("."))


class DownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.ref = f"{ART['name']}@{ART['version']}"

    def test_peft_download_extracts_a_vllm_loadable_directory(self) -> None:
        bundle = bundle_bytes(PEFT_FILES, manifest_extra={"base_model": "qwen/qwen3-8b"})
        client, sender, _ = make_client(routes(bundle))
        out = client.artifacts.download(self.ref, self.dir / "fast-diff-merge")
        self.assertEqual(out, self.dir / "fast-diff-merge")
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["README.md", "adapter_config.json", "adapter_model.safetensors", "manifest.json"])
        self.assertEqual((out / "adapter_model.safetensors").read_bytes(), b"\x00" * 64)
        self.assertEqual(leftovers(self.dir), [])
        self.assertEqual(sender.sent[-1].header("Accept"), "application/octet-stream")
        mode = (out / "adapter_config.json").stat().st_mode & 0o777
        umask = os.umask(0)
        os.umask(umask)
        self.assertEqual(mode, 0o666 & ~umask)

    def test_merged_weights_count_as_peft(self) -> None:
        bundle = bundle_bytes({"config.json": b"{}", "model.safetensors": b"w"})
        client, _, _ = make_client(routes(bundle, fmt="merged_safetensors"))
        out = client.artifacts.download(self.ref, self.dir / "merged")
        self.assertTrue((out / "model.safetensors").exists())

    def test_non_peft_artifacts_need_files_or_bundle(self) -> None:
        bundle = bundle_bytes({"reference_model.json": b"{}"}, manifest_extra={"format": "reference"})
        client, _, _ = make_client(routes(bundle, fmt="reference"))
        with self.assertRaises(ValueError) as ctx:
            client.artifacts.download(self.ref, self.dir / "x")
        self.assertIn("format='files'", str(ctx.exception))
        self.assertFalse((self.dir / "x").exists())
        self.assertEqual(leftovers(self.dir), [])
        out = client.artifacts.download(self.ref, self.dir / "x", format="files")
        self.assertTrue((out / "reference_model.json").exists())

    def test_bundle_download_to_directory_or_file(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        client, _, _ = make_client(routes(bundle))
        out = client.artifacts.download(self.ref, self.dir, format="bundle")
        self.assertEqual(out.name, f"{ART['name']}-{ART['version']}.grad.tar.gz")
        self.assertEqual(out.read_bytes(), bundle)
        with self.assertRaises(FileExistsError):
            client.artifacts.download(self.ref, out, format="bundle")
        again = client.artifacts.download(self.ref, out, format="bundle", overwrite=True)
        self.assertEqual(again, out)
        nested = client.artifacts.download(self.ref, self.dir / "a" / "b" / "x.grad.tar.gz", format="bundle")
        self.assertTrue(nested.exists())
        self.assertEqual(leftovers(self.dir), [])

    def test_checksum_mismatch_discards_everything(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        bad = "f" * 64
        client, _, _ = make_client(routes(bundle, header_sha=bad, declared=bad))
        for fmt in ("peft", "bundle"):
            with self.subTest(fmt=fmt), self.assertRaises(grad.ChecksumMismatchError) as ctx:
                client.artifacts.download(self.ref, self.dir / "out.grad.tar.gz" if fmt == "bundle" else self.dir / "out", format=fmt)
            self.assertEqual(ctx.exception.expected, bad)
            self.assertEqual(ctx.exception.actual, hashlib.sha256(bundle).hexdigest())
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [])

    def test_header_must_be_present_valid_and_agree_with_the_artifact(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        client, _, _ = make_client(routes(bundle, header_sha="", declared="nothex"))
        with self.assertRaises(grad.ChecksumMismatchError) as ctx:
            client.artifacts.download(self.ref, self.dir / "o")
        self.assertIn("valid SHA-256", str(ctx.exception))
        client, _, _ = make_client(routes(bundle, header_sha="a" * 64))
        with self.assertRaises(grad.ChecksumMismatchError) as ctx:
            client.artifacts.download(self.ref, self.dir / "o")
        self.assertIn("differs", str(ctx.exception))
        upper = hashlib.sha256(bundle).hexdigest().upper()
        client, _, _ = make_client(routes(bundle, header_sha=upper))
        self.assertTrue(client.artifacts.download(self.ref, self.dir / "ok").exists())
        self.assertEqual(leftovers(self.dir), [])

    def test_interrupted_download_is_cleaned_up(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        client, _, _ = make_client(routes(bundle, error=ConnectionResetError("reset")))
        with self.assertRaises(grad.APIConnectionError):
            client.artifacts.download(self.ref, self.dir / "o")
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [])

    def test_target_directory_rules(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        client, _, _ = make_client(routes(bundle))
        target = self.dir / "existing"
        target.mkdir()
        (target / "keep.txt").write_text("x")
        with self.assertRaises(FileExistsError):
            client.artifacts.download(self.ref, target)
        client.artifacts.download(self.ref, target, overwrite=True)
        self.assertFalse((target / "keep.txt").exists())
        empty = self.dir / "empty"
        empty.mkdir()
        client.artifacts.download(self.ref, empty)
        self.assertTrue((empty / "adapter_config.json").exists())
        afile = self.dir / "afile"
        afile.write_text("x")
        with self.assertRaises(FileExistsError):
            client.artifacts.download(self.ref, afile)
        with self.assertRaises(ValueError):
            client.artifacts.download(self.ref, self.dir / "z", format="zip")

    def test_artifact_and_run_download_methods(self) -> None:
        bundle = bundle_bytes(PEFT_FILES)
        client, _, _ = make_client(routes(bundle))
        art = grad.Artifact.from_api(artifact(bundle), client)
        self.assertTrue(art.download(self.dir / "a").exists())
        run = grad.Run.from_api({**fixture("python-run-completed.json"), "artifact_id": self.ref}, client)
        self.assertTrue(run.download(self.dir / "r").exists())


def _tar(entries: list[tuple[tarfile.TarInfo, bytes | None]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for info, content in entries:
            if content is not None:
                info.size = len(content)
            tf.addfile(info, io.BytesIO(content) if content is not None else None)
    return buf.getvalue()


def _file(name: str, content: bytes = b"x") -> tuple[tarfile.TarInfo, bytes]:
    return tarfile.TarInfo(name), content


class ExtractionSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / "dest"
        self.dest.mkdir()

    def extract(self, data: bytes, **kwargs: int) -> dict:
        path = self.root / "b.tgz"
        path.write_bytes(data)
        self.dest = Path(tempfile.mkdtemp(dir=self.root, prefix="dest-"))
        return safe_extract_bundle(path, self.dest, **kwargs)

    def manifest(self, files: dict[str, bytes]) -> tuple[tarfile.TarInfo, bytes]:
        return _file("manifest.json", json.dumps({"files": {n: hashlib.sha256(c).hexdigest() for n, c in files.items()}}).encode())

    def assert_unsafe(self, data: bytes, needle: str) -> None:
        with self.assertRaises(grad.UnsafeArchiveError) as ctx:
            self.extract(data)
        self.assertIn(needle, str(ctx.exception))
        self.assertFalse((self.root / "evil").exists())
        self.assertFalse((self.root / "etc").exists())

    def test_path_traversal_and_absolute_paths(self) -> None:
        for name in ("../evil", "a/../../evil", "/etc/passwd", "a//b", "./x", "C:/x", "a\\b"):
            with self.subTest(name=name):
                self.assert_unsafe(_tar([_file(name)]), "unsafe")

    def test_links_and_devices(self) -> None:
        sym = tarfile.TarInfo("link")
        sym.type = tarfile.SYMTYPE
        sym.linkname = "/etc/passwd"
        self.assert_unsafe(_tar([(sym, None)]), "regular files")
        hard = tarfile.TarInfo("hard")
        hard.type = tarfile.LNKTYPE
        hard.linkname = "manifest.json"
        self.assert_unsafe(_tar([(hard, None)]), "regular files")
        fifo = tarfile.TarInfo("fifo")
        fifo.type = tarfile.FIFOTYPE
        self.assert_unsafe(_tar([(fifo, None)]), "regular files")

    def test_duplicates_member_and_size_limits(self) -> None:
        self.assert_unsafe(_tar([_file("a"), _file("a")]), "Duplicate")
        with self.assertRaises(grad.UnsafeArchiveError):
            self.extract(_tar([_file("a"), _file("b"), _file("c")]), max_members=2)
        with self.assertRaises(grad.UnsafeArchiveError):
            self.extract(_tar([_file("a", b"x" * 100)]), max_bytes=10)

    def test_manifest_verification(self) -> None:
        files = {"adapter_config.json": b"{}"}
        self.assert_unsafe(_tar([_file("adapter_config.json", b"{}")]), "no manifest.json")
        self.assert_unsafe(_tar([_file("manifest.json", b"{nope"), _file("a")]), "not valid JSON")
        self.assert_unsafe(_tar([_file("manifest.json", b"{}")]), "no 'files'")
        self.assert_unsafe(_tar([self.manifest(files), _file("adapter_config.json", b"{}"), _file("extra.bin")]), "not listed")
        self.assert_unsafe(_tar([self.manifest(files)]), "missing from the bundle")
        with self.assertRaises(grad.ChecksumMismatchError):
            self.extract(_tar([self.manifest(files), _file("adapter_config.json", b"tampered")]))
        report = b'{"eval_loss": 0.1}'
        bad_manifest = _file("manifest.json", json.dumps({"files": {}, "eval_report_sha256": "0" * 64}).encode())
        with self.assertRaises(grad.ChecksumMismatchError):
            self.extract(_tar([bad_manifest, _file("eval_report.json", report)]))
        good_manifest = _file("manifest.json", json.dumps({"files": {}, "eval_report_sha256": hashlib.sha256(report).hexdigest()}).encode())
        self.assertEqual(self.extract(_tar([good_manifest, _file("eval_report.json", report)]))["files"], {})

    def test_directories_are_allowed_and_nested_files_extract(self) -> None:
        files = {"sub/weights.bin": b"w"}
        d = tarfile.TarInfo("sub")
        d.type = tarfile.DIRTYPE
        self.extract(_tar([(d, None), self.manifest(files), _file("sub/weights.bin", b"w")]))
        self.assertEqual((self.dest / "sub" / "weights.bin").read_bytes(), b"w")

    def test_corrupt_and_non_gzip_bundles(self) -> None:
        self.assert_unsafe(b"not a tarball", "not a valid")
        data = _tar([self.manifest({"a": b"x" * 5000}), _file("a", b"x" * 5000)])
        self.assert_unsafe(data[: len(data) // 2], "Corrupt")


if __name__ == "__main__":
    unittest.main()
