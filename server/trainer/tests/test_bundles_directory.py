"""Streaming directory bundles: determinism, verification and path safety."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from grad_trainer.bundles import bundle_directory, extract_bundle, read_artifact_bundle


def _tar_gz(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with (
        gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz,
        tarfile.open(fileobj=gz, mode="w") as tf,
    ):
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        if symlink:
            info = tarfile.TarInfo(symlink)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tf.addfile(info)
    return buf.getvalue()


def _manifest(files: dict[str, bytes]) -> bytes:
    return json.dumps(
        {
            "schema": "grad.artifact/1",
            "files": {n: hashlib.sha256(d).hexdigest() for n, d in files.items()},
        }
    ).encode()


class DirectoryBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.src = self.tmp / "src"
        (self.src / "sub").mkdir(parents=True)
        (self.src / "adapter_model.safetensors").write_bytes(b"w" * 3000)
        (self.src / "sub" / "tokenizer.json").write_text("{}")

    def test_roundtrip_is_deterministic_and_verified(self) -> None:
        a, b = self.tmp / "a.tgz", self.tmp / "b.tgz"
        sha_a, size_a = bundle_directory(
            self.src, a, manifest={"format": "peft_lora"}, eval_report={"loss": 1}
        )
        sha_b, _ = bundle_directory(
            self.src, b, manifest={"format": "peft_lora"}, eval_report={"loss": 1}
        )
        self.assertEqual(sha_a, sha_b)
        self.assertEqual(sha_a, hashlib.sha256(a.read_bytes()).hexdigest())
        self.assertEqual(size_a, a.stat().st_size)

        manifest = extract_bundle(a, self.tmp / "out")
        self.assertEqual(manifest["format"], "peft_lora")
        self.assertEqual(
            (self.tmp / "out" / "sub" / "tokenizer.json").read_text(), "{}"
        )
        self.assertIn("eval_report.json", manifest["files"])
        # The in-memory reader accepts directory bundles too.
        read_manifest, files = read_artifact_bundle(a.read_bytes())
        self.assertEqual(read_manifest["files"], manifest["files"])
        self.assertIn("sub/tokenizer.json", files)

    def test_rejects_symlinks_and_reserved_names(self) -> None:
        (self.src / "link").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            bundle_directory(self.src, self.tmp / "x.tgz", manifest={})
        (self.src / "link").unlink()
        (self.src / "manifest.json").write_text("{}")
        with self.assertRaises(ValueError):
            bundle_directory(self.src, self.tmp / "x.tgz", manifest={})

    def test_tampered_member_and_eval_report_fail(self) -> None:
        files = {"w.bin": b"good", "eval_report.json": b'{"loss": 1}'}
        manifest = _manifest(files)
        forged = self.tmp / "forged.tgz"
        forged.write_bytes(
            _tar_gz(
                {
                    "manifest.json": manifest,
                    "w.bin": b"good",
                    "eval_report.json": b'{"loss": 0}',
                }
            )
        )
        with self.assertRaises(ValueError):
            extract_bundle(forged, self.tmp / "out1")
        self.assertFalse((self.tmp / "out1").exists())

        undeclared = self.tmp / "undeclared.tgz"
        undeclared.write_bytes(
            _tar_gz(
                {
                    "manifest.json": _manifest({"w.bin": b"good"}),
                    "w.bin": b"good",
                    "extra": b"x",
                }
            )
        )
        with self.assertRaises(ValueError):
            extract_bundle(undeclared, self.tmp / "out2")

    def test_rejects_traversal_links_and_size(self) -> None:
        for name, data in {
            "trav.tgz": _tar_gz({"../evil": b"x"}),
            "abs.tgz": _tar_gz({"/abs": b"x"}),
            "link.tgz": _tar_gz({"manifest.json": b"{}"}, symlink="ln"),
            "noschema.tgz": _tar_gz({"manifest.json": b"{}"}),
        }.items():
            path = self.tmp / name
            path.write_bytes(data)
            with self.assertRaises(ValueError, msg=name):
                extract_bundle(path, self.tmp / f"out-{name}")

        big = self.tmp / "big.tgz"
        bundle_directory(self.src, big, manifest={})
        with self.assertRaises(ValueError):
            extract_bundle(big, self.tmp / "out-big", max_bytes=100)

    def test_destination_must_be_empty(self) -> None:
        bundle = self.tmp / "a.tgz"
        bundle_directory(self.src, bundle, manifest={})
        dest = self.tmp / "busy"
        dest.mkdir()
        (dest / "keep").write_text("x")
        with self.assertRaises(ValueError):
            extract_bundle(bundle, dest)
        self.assertTrue((dest / "keep").exists())


if __name__ == "__main__":
    unittest.main()
