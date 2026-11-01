"""Contract tests for Noema's short-lived Hy Memory adapter."""

import importlib.util
import pathlib
import unittest
import tempfile
from unittest.mock import patch


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "noema-hy-memory.py"
SPEC = importlib.util.spec_from_file_location("noema_hy_memory_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class FakeClient:
    def __init__(self):
        self.calls = []

    def search(self, query, **kwargs):
        self.calls.append(("search", query, kwargs))
        return {"memories": {
            "normal": [{"memory_id": "m1", "content": "Prefers concise replies"}],
            "profile": [], "schema": [],
        }}

    def add(self, messages, **kwargs):
        self.calls.append(("add", messages, kwargs))
        return {"success": True}


class BridgeTests(unittest.TestCase):
    def test_private_pi_runtime_does_not_require_a_system_pi(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config, runtime, gateway = (root / name for name in ("memory.env", "runtime.js", "gateway.mjs"))
            config.write_text("MEMORY_LLM_BACKEND=noema-pi\nMEMORY_EMBEDDER_BASE_URL=https://fixture.test\n"
                              "MEMORY_EMBEDDER_MODEL=fixture\nMEMORY_EMBEDDER_API_KEY=fixture-only\n")
            config.chmod(0o600)
            runtime.write_text("fixture")
            gateway.write_text("fixture")
            (root / "models.json").write_text("{}")
            with patch.dict(bridge.os.environ, {}, clear=True), \
                 patch.object(bridge, "CONFIG_FILE", config), patch.object(bridge, "PI_RUNTIME", runtime), \
                 patch.object(bridge, "PI_GATEWAY", gateway), patch.object(bridge, "PI_AGENT_DIR", root), \
                 patch.object(bridge.shutil, "which", side_effect=lambda name: "/fixture/node" if name == "node" else None):
                self.assertTrue(bridge.load_config())
                runtime.unlink()
                self.assertFalse(bridge.load_config())

    def test_project_identity_is_stable_and_isolated(self):
        self.assertEqual(bridge.project_user("/tmp/a"), bridge.project_user("/tmp/a/"))
        self.assertNotEqual(bridge.project_user("/tmp/a"), bridge.project_user("/tmp/b"))
        with self.assertRaises(ValueError):
            bridge.project_user("relative")

    def test_recall_is_scoped_and_bounded(self):
        client = FakeClient()
        result = bridge.search(client, {"query": "How should I respond?"}, "project-a")
        self.assertEqual(result["items"], [{"id": "m1", "content": "Prefers concise replies"}])
        self.assertEqual(client.calls[0][2]["user_ids"], ["project-a"])
        self.assertEqual(client.calls[0][2]["agent_ids"], ["shared"])

    def test_completed_turn_uses_shared_scope_and_stable_request_id(self):
        client = FakeClient()
        request = {"prompt": "What next?", "answer": "Run the test.",
                   "session": "session-1", "source": "noema-run"}
        self.assertTrue(bridge.remember(client, request, "project-a")["stored"])
        self.assertTrue(bridge.remember(client, request, "project-a")["stored"])
        first, second = [call[2] for call in client.calls]
        self.assertEqual(first["request_id"], second["request_id"])
        self.assertEqual(first["agent_id"], "shared")
        self.assertEqual(first["scene"], "chat")
        self.assertEqual(first["source"], "noema-run")


if __name__ == "__main__":
    unittest.main()
