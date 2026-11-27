"""Seam lookups used by the worker: recipe registry and the import runner."""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

from fixtures.tiny_models import torch_available

from grad_trainer import import_runner, protocol, runner_types
from grad_trainer.errors import BackendUnavailableError


class ProtocolResolutionTests(unittest.TestCase):
    def test_seam_types_have_one_definition(self) -> None:
        for name in ("Budget", "RunCallbacks", "ResumeState", "RunOutput", "ImportSummary"):
            self.assertIs(getattr(protocol, name), getattr(runner_types, name))

    def test_every_v0_recipe_resolves_to_a_runner(self) -> None:
        kinds = protocol.supported_recipe_kinds()
        self.assertEqual(
            sorted(kinds or []),
            ["cartridge", "decision", "dpo", "embedding", "router", "sft"],
        )
        for kind in kinds or []:
            if torch_available():
                self.assertTrue(callable(protocol.resolve_recipe_runner(kind).run))
            else:
                with self.assertRaises(BackendUnavailableError):
                    protocol.resolve_recipe_runner(kind)

    def test_import_runner_defaults_to_the_connector_module(self) -> None:
        self.assertIs(protocol.resolve_import_runner(), import_runner)

    def test_import_runner_prefers_a_factory_then_an_object(self) -> None:
        sentinel = types.SimpleNamespace(run=lambda *a, **k: None)
        fake = types.ModuleType("grad_trainer.import_runner")
        fake.get_import_runner = lambda: sentinel  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"grad_trainer.import_runner": fake}):
            self.assertIs(protocol.resolve_import_runner(), sentinel)

        obj = types.ModuleType("grad_trainer.import_runner")
        obj.import_runner = sentinel  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"grad_trainer.import_runner": obj}):
            self.assertIs(protocol.resolve_import_runner(), sentinel)

    def test_missing_import_runner_resolves_to_none(self) -> None:
        empty = types.ModuleType("grad_trainer.import_runner")
        with mock.patch.dict(sys.modules, {"grad_trainer.import_runner": empty}):
            self.assertIsNone(protocol.resolve_import_runner())
        with mock.patch.object(protocol, "IMPORT_RUNNER_MODULES", ("grad_trainer.does_not_exist",)):
            self.assertIsNone(protocol.resolve_import_runner())


if __name__ == "__main__":
    unittest.main()
