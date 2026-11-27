"""Artifact bundles: determinism, tamper detection, reserved names and archive-bomb guards."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tarfile

from helpers import TempDirCase

from grad_trainer import bundles
from grad_trainer.bundles import build_artifact_bundle, bundle_directory, extract_bundle, read_artifact_bundle


def tar_gz(entries: list[tuple[tarfile.TarInfo, bytes | None]]) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tf:
        for info, data in entries:
            tf.addfile(info, io.BytesIO(data) if data is not None else None)
    return buf.getvalue()


def file_info(name: str, data: bytes) -> tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    return info, data


def manifest_entry(files: dict[str, bytes], **extra) -> tuple[tarfile.TarInfo, bytes]:
    m = {"schema": "grad.artifact/1", "files": {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}, **extra}
    return file_info("manifest.json", json.dumps(m).encode())


class BundleTests(TempDirCase):
    def make_dir(self):
        src = self.tmpdir()
        (src / "adapter_config.json").write_text('{"r": 4}')
        (src / "sub").mkdir()
        (src / "sub" / "w.bin").write_bytes(os.urandom(2048))
        return src

    def test_directory_bundle_is_deterministic_and_verifies(self) -> None:
        src = self.make_dir()
        out = self.tmpdir()
        a = bundle_directory(src, out / "a.grad.tar.gz", manifest={"recipe_kind": "sft"}, eval_report={"eval_loss": 1.0}, validate=False)
        b = bundle_directory(src, out / "b.grad.tar.gz", manifest={"recipe_kind": "sft"}, eval_report={"eval_loss": 1.0}, validate=False)
        self.assertEqual(a.sha256, b.sha256)
        self.assertEqual((out / "a.grad.tar.gz").read_bytes(), (out / "b.grad.tar.gz").read_bytes())
        manifest, files = read_artifact_bundle(a.path)
        self.assertEqual(set(files), {"manifest.json", "eval_report.json", "adapter_config.json", "sub/w.bin"})
        self.assertEqual(manifest["files"]["sub/w.bin"], hashlib.sha256((src / "sub" / "w.bin").read_bytes()).hexdigest())
        dest = self.tmpdir() / "x"
        extracted = extract_bundle(a.path, dest)
        self.assertEqual(extracted["recipe_kind"], "sft")
        self.assertEqual((dest / "sub" / "w.bin").read_bytes(), (src / "sub" / "w.bin").read_bytes())
        with self.assertRaisesRegex(ValueError, "not empty"):
            extract_bundle(a.path, dest)

    def test_in_memory_bundle_is_deterministic(self) -> None:
        kwargs = {"manifest": {"recipe": "x"}, "files": {"w": b"1"}, "eval_report": {"a": 1}}
        self.assertEqual(build_artifact_bundle(**kwargs), build_artifact_bundle(**kwargs))
        manifest, files = read_artifact_bundle(build_artifact_bundle(manifest={"r": 1}, files={"w": b"1"}))
        self.assertNotIn("eval_report_sha256", manifest)

    def test_reserved_names_symlinks_and_bad_manifest(self) -> None:
        for name in ("manifest.json", "eval_report.json", "../x", "/abs", "a//b", "a\\b"):
            with self.subTest(name), self.assertRaises(ValueError):
                build_artifact_bundle(manifest={}, files={name: b"x"})
        with self.assertRaises(ValueError):
            build_artifact_bundle(manifest=[], files={})  # type: ignore[arg-type]
        src = self.make_dir()
        (src / "manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "reserved"):
            bundle_directory(src, self.tmpdir() / "o", manifest={})
        src = self.make_dir()
        os.symlink("/etc/passwd", src / "link")
        with self.assertRaisesRegex(ValueError, "symlink"):
            bundle_directory(src, self.tmpdir() / "o", manifest={})
        src = self.make_dir()
        os.mkfifo(src / "fifo")
        with self.assertRaisesRegex(ValueError, "non-regular"):
            bundle_directory(src, self.tmpdir() / "o", manifest={})

    def test_tampering_is_detected(self) -> None:
        good = build_artifact_bundle(manifest={"r": 1}, files={"w": b"weights"}, eval_report={"acc": 0.5})
        _, files = read_artifact_bundle(good)

        def rebuild(**changes):
            entries = {**files, **changes}
            return tar_gz([file_info(k, v) for k, v in entries.items() if v is not None])

        cases = {
            "forged eval report": rebuild(**{"eval_report.json": b'{"acc": 0.99}'}),
            "missing eval report": rebuild(**{"eval_report.json": None}),
            "changed weights": rebuild(w=b"evil"),
            "undeclared file": rebuild(extra=b"x"),
            "missing file": rebuild(w=None),
            "no manifest": rebuild(**{"manifest.json": None}),
            "bad schema": rebuild(**{"manifest.json": b'{"schema": "x", "files": {}}'}),
            "non-object manifest": rebuild(**{"manifest.json": b"[]"}),
            "invalid manifest": rebuild(**{"manifest.json": b"{nope"}),
            "no files map": rebuild(**{"manifest.json": b'{"schema": "grad.artifact/1"}'}),
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                read_artifact_bundle(data)

    def test_hostile_archives_are_rejected(self) -> None:
        sym = tarfile.TarInfo("link")
        sym.type = tarfile.SYMTYPE
        sym.linkname = "/etc/passwd"
        hard = tarfile.TarInfo("hard")
        hard.type = tarfile.LNKTYPE
        hard.linkname = "manifest.json"
        m = manifest_entry({})
        cases = {
            "traversal": [m, file_info("../evil", b"x")],
            "absolute": [m, file_info("/etc/evil", b"x")],
            "symlink": [m, (sym, None)],
            "hardlink": [m, (hard, None)],
            "duplicate": [manifest_entry({"a": b"1"}), file_info("a", b"1"), file_info("a", b"1")],
        }
        for name, entries in cases.items():
            data = tar_gz(entries)
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    read_artifact_bundle(data)
                path = self.tmpdir() / "b.tgz"
                path.write_bytes(data)
                dest = self.tmpdir() / "out"
                with self.assertRaises(ValueError):
                    extract_bundle(path, dest)
                self.assertFalse(dest.exists())

    def test_bomb_guards(self) -> None:
        many = tar_gz([manifest_entry({})] + [file_info(f"f{i}", b"") for i in range(40)])
        with self.assertRaisesRegex(ValueError, "entries"):
            read_artifact_bundle(many, max_members=10)
        big = tar_gz([manifest_entry({"z": b"\0" * 100_000}), file_info("z", b"\0" * 100_000)])
        self.assertLess(len(big), 2_000)  # highly compressible
        with self.assertRaisesRegex(ValueError, "uncompressed limit"):
            read_artifact_bundle(big, max_uncompressed_bytes=50_000)
        path = self.tmpdir() / "big.tgz"
        path.write_bytes(big)
        with self.assertRaisesRegex(ValueError, "uncompressed limit"):
            extract_bundle(path, self.tmpdir() / "o", max_uncompressed_bytes=50_000)
        # A member whose header lies about its size is still cut off by the read bound.
        with self.assertRaisesRegex(ValueError, "uncompressed limit"):
            bundles._copy_bounded(io.BytesIO(b"x" * 10), None, 5)
