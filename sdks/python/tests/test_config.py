"""Configuration precedence: explicit args > environment > grad login config file > defaults."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import _fakes  # noqa: F401  (puts the SDK on sys.path)

import grad
from grad._config import DEFAULT_BASE_URL, default_config_path, is_loopback, normalize_base_url, resolve_config


class ConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.cfg = self.home / "xdg" / "gradiated" / "config.json"
        self.cfg.parent.mkdir(parents=True)
        self.env = {"XDG_CONFIG_HOME": str(self.home / "xdg"), "HOME": str(self.home)}

    def write(self, data: object) -> None:
        self.cfg.write_text(json.dumps(data))

    def test_default_path(self) -> None:
        self.assertEqual(default_config_path(self.env), self.cfg)
        self.assertEqual(default_config_path({"HOME": "/h"}), Path("/h/.config/gradiated/config.json"))

    def test_defaults_require_a_key_for_cloud(self) -> None:
        with self.assertRaises(grad.GradConfigError) as ctx:
            resolve_config(env=self.env)
        text = str(ctx.exception)
        self.assertIn("GRADIATED_API_KEY", text)
        self.assertIn("grad login", text)
        self.assertIn(DEFAULT_BASE_URL, text)

    def test_loopback_and_explicit_empty_key_need_no_key(self) -> None:
        self.assertIsNone(resolve_config(base_url="http://localhost:8787", env=self.env).api_key)
        self.assertIsNone(resolve_config(base_url="http://127.0.0.1:8787", env=self.env).api_key)
        self.assertIsNone(resolve_config(base_url="http://[::1]:8787", env=self.env).api_key)
        self.assertIsNone(resolve_config(api_key="", env=self.env).api_key)
        self.assertTrue(is_loopback("http://app.localhost"))
        self.assertFalse(is_loopback("http://grad.internal"))

    def test_env_vars(self) -> None:
        env = {**self.env, "GRADIATED_API_KEY": "grad_env", "GRADIATED_BASE_URL": "https://grad.internal/"}
        cfg = resolve_config(env=env)
        self.assertEqual((cfg.base_url, cfg.api_key), ("https://grad.internal", "grad_env"))
        self.assertEqual(cfg.sources, {"base_url": "env:GRADIATED_BASE_URL", "api_key": "env:GRADIATED_API_KEY"})

    def test_explicit_beats_env_beats_file(self) -> None:
        self.write({"profiles": {"default": {"base_url": "https://file.example", "api_key": "grad_file"}}})
        cfg = resolve_config(env=self.env)
        self.assertEqual((cfg.base_url, cfg.api_key), ("https://file.example", "grad_file"))
        self.assertTrue(cfg.sources["api_key"].startswith("config:"))
        env = {**self.env, "GRADIATED_API_KEY": "grad_env"}
        cfg = resolve_config(env=env)
        self.assertEqual((cfg.base_url, cfg.api_key), ("https://file.example", "grad_env"))
        cfg = resolve_config(api_key="grad_arg", base_url="http://localhost:9", env=env)
        self.assertEqual((cfg.base_url, cfg.api_key), ("http://localhost:9", "grad_arg"))

    def test_profiles(self) -> None:
        self.write({"profiles": {"default": {"api_key": "a"}, "staging": {"base_url": "https://staging.example", "api_key": "b"}}})
        cfg = resolve_config(profile="staging", env=self.env)
        self.assertEqual((cfg.base_url, cfg.api_key, cfg.profile), ("https://staging.example", "b", "staging"))
        with self.assertRaises(grad.GradConfigError) as ctx:
            resolve_config(profile="prod", env=self.env)
        self.assertIn("default, staging", str(ctx.exception))
        os.remove(self.cfg)
        with self.assertRaises(grad.GradConfigError):
            resolve_config(profile="staging", env=self.env)

    def test_malformed_files(self) -> None:
        self.cfg.write_text("{nope")
        with self.assertRaises(grad.GradConfigError):
            resolve_config(env=self.env)
        self.write([1, 2])
        with self.assertRaises(grad.GradConfigError):
            resolve_config(env=self.env)
        self.write({"profiles": {"default": "x"}})
        with self.assertRaises(grad.GradConfigError):
            resolve_config(env=self.env)
        # A broken file is not read when arguments/env cover everything.
        self.cfg.write_text("{nope")
        self.assertEqual(resolve_config(api_key="k", base_url="https://x.example", env=self.env).api_key, "k")
        directory_path = self.home / "dir.json"
        directory_path.mkdir()
        with self.assertRaises(grad.GradConfigError):
            resolve_config(config_path=directory_path, env=self.env)

    def test_config_path_override(self) -> None:
        other = self.home / "other.json"
        other.write_text(json.dumps({"profiles": {"default": {"api_key": "grad_other", "base_url": "http://localhost:1"}}}))
        self.assertEqual(resolve_config(config_path=other, env=self.env).api_key, "grad_other")

    def test_base_url_validation(self) -> None:
        self.assertEqual(normalize_base_url(" https://a.example/prefix/ "), "https://a.example/prefix")
        for bad in ("api.gradiated.com", "ftp://x", "https://u:p@x.example", "https://x.example?a=1", "https://x.example:99999", "http://"):
            with self.subTest(bad=bad), self.assertRaises(grad.GradConfigError):
                normalize_base_url(bad)

    def test_key_with_whitespace(self) -> None:
        with self.assertRaises(grad.GradConfigError):
            resolve_config(api_key="grad abc", env=self.env)
        self.assertEqual(resolve_config(api_key=" grad_x\n", env=self.env).api_key, "grad_x")

    def test_repr_masks_the_key(self) -> None:
        cfg = resolve_config(api_key="grad_supersecretvalue", env=self.env)
        self.assertNotIn("supersecret", repr(cfg))
        client = grad.Grad(api_key="grad_supersecretvalue", _env=self.env)
        self.assertNotIn("supersecret", repr(client))
        self.assertEqual(client.base_url, DEFAULT_BASE_URL)
        self.assertEqual(client.config.api_key, "grad_supersecretvalue")
        client.close()
        short = resolve_config(api_key="k", env=self.env)
        self.assertIn("…", repr(short))

    def test_clients_use_process_environment(self) -> None:
        old = dict(os.environ)
        try:
            os.environ["GRADIATED_API_KEY"] = "grad_from_env"
            os.environ["GRADIATED_BASE_URL"] = "http://localhost:8787"
            with grad.Grad() as client:
                self.assertEqual(client.config.api_key, "grad_from_env")
                self.assertEqual(client.base_url, "http://localhost:8787")
            self.assertEqual(grad.AsyncGrad().base_url, "http://localhost:8787")
        finally:
            os.environ.clear()
            os.environ.update(old)


if __name__ == "__main__":
    unittest.main()
