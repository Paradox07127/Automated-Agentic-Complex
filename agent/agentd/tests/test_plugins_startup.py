"""Run main in an isolated process and inspect its workers at the ready boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

AGENTD = Path(__file__).resolve().parents[1]
IDS = ("light_ai", "screen_awareness", "screen_reading", "daily_brief", "coding_sessions", "personal_agent",
       "harness_bridge", "computer_use", "external_access", "motion_generation")
WORKERS = {"continuous-observation", "worklog", "personal-memory-maintenance", "personal-job-0",
           "personal-job-1", "personal-job-leases", "runtime-discovery-refresh"}

def probe():
    import threading
    import time
    from contextlib import closing
    from unittest.mock import patch

    sys.path[:0] = [str(AGENTD), str(AGENTD / "tests")]
    from character_agent.harness.discovery import DiscoveryService
    from character_agent.services.jobs import JobStore
    from character_agent.services.workspace import WorkspaceService
    from daemon.main import AgentdServer, main
    from infra import paths
    from infra.store import open_store
    from observation.attention import AttentionStore
    from observation.blacklist import Blacklist
    from personal.memory import Memory
    from test_plugin_routes import request

    state = Path(sys.argv[sys.argv.index("--state-dir") + 1])
    state.mkdir()
    # Recovery starts the job workers only when there is queued work.
    with closing(open_store(paths.agentd_db(state))) as db:
        JobStore(Memory(db)).submit("fixture", {})

    directory = state / "character-agent" / "files"
    if os.environ.get("TEST_PLUGIN_RESET"):
        with closing(AttentionStore(paths.attention_db(state), Blacklist(paths.blacklist(state)))) as attention:
            attention.log_state(attention.clock(), "test", "test", [])
        with closing(WorkspaceService(directory)) as workspace:
            workspace.create_scope(files=[str(paths.__file__)])

    observed = threading.Event()

    def candidates(_discovery):
        observed.wait(15)
        return []

    def serve(server):
        while server.startup_stage != "ready":
            time.sleep(.01)
        assert paths.ui_runtime(state).is_file()
        code, caps = request(server, "GET", "/capabilities")
        assert code == 200
        agent = server.character_agent
        services = {name: getattr(agent, name, None) is not None for name in
                    ("workspace", "discovery", "jobs", "observations", "observation_briefs", "worklog", "memory_pipeline")}
        snapshot = {"services": services, "workers": [t.name for t in threading.enumerate()], "caps": caps,
                    "integration": (state / "integration-runtime.json").is_file(), "degraded": server.degraded}
        if os.environ.get("TEST_USER_COARSE"):
            snapshot["coarse"] = request(server, "POST", "/user/coarse", {"ts": time.time(), "idle_s": 0,
                                                                          "mic_active": True})
            snapshot["user_now"] = request(server, "GET", "/user/now")
            snapshot["attention_db"] = paths.attention_db(state).exists()
        if os.environ.get("TEST_PLUGIN_RESET"):
            status, answer = server.reset()
            assert status == 200, answer
            with closing(WorkspaceService(directory)) as workspace, closing(AttentionStore(
                    paths.attention_db(state), Blacklist(paths.blacklist(state)))) as attention:
                snapshot["remaining"] = [len(workspace.list_scopes()),
                                         attention.db.execute("SELECT COUNT(*) FROM state_log").fetchone()[0]]
        if os.environ.get("TEST_PLUGIN_BRIEF"):
            snapshot["brief"] = agent.observation_briefs.run_once()["state"]
        print("snapshot " + json.dumps(snapshot), flush=True)
        observed.set()

    def bind(server):
        server.server_port = server.server_address[1]

    with patch.object(AgentdServer, "server_bind", bind), patch.object(AgentdServer, "server_activate"), \
            patch.object(AgentdServer, "serve_forever", serve), patch.object(AgentdServer, "shutdown"), \
            patch.object(DiscoveryService, "_local_candidates", candidates):
        main()
    assert not paths.ui_runtime(state).exists(), "orderly shutdown left the daemon address published"


class PluginStartupTest(unittest.TestCase):
    def run_main(self, *flags, **env):
        with tempfile.TemporaryDirectory() as directory:
            return subprocess.run([sys.executable, "-I", str(Path(__file__).resolve()),
                                   "--port", "48810", "--state-dir", str(Path(directory) / "state"),
                                   "--no-exit-with-parent", "--mute", *flags],
                                  env={**os.environ, "HOME": directory, **env}, capture_output=True, text=True,
                                  encoding="utf-8", timeout=25)

    def snapshot(self, *flags, **env):
        result = self.run_main(*flags, **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Exception in thread", result.stderr)
        return json.loads(next(line[9:] for line in result.stdout.splitlines() if line.startswith("snapshot ")))

    def test_workers_capabilities_and_token_publication(self):
        for flag in ("--plugin-off", "--plugin-on", None):
            with self.subTest(flag=flag):
                state = self.snapshot(*(arg for ident in IDS for arg in (flag, ident) if flag))
                expected = {i: flag == "--plugin-on" or flag is None and i == "light_ai" for i in IDS}
                self.assertEqual(state["caps"]["plugins"], expected)
                workers = WORKERS if flag == "--plugin-on" else {"personal-memory-maintenance"} if flag is None else set()
                self.assertEqual(WORKERS.intersection(state["workers"]), workers)
                self.assertEqual(state["integration"], expected["external_access"])
                self.assertEqual(state["degraded"], [])

    def test_services_can_be_enabled_independently(self):
        owners = {"workspace": "personal_agent", "discovery": "harness_bridge", "jobs": "personal_agent",
                  "observations": "screen_awareness", "observation_briefs": "daily_brief", "worklog": "daily_brief",
                  "memory_pipeline": "light_ai"}
        for plugin in IDS:
            with self.subTest(plugin=plugin):
                flags = [] if plugin == "light_ai" else ["--plugin-off", "light_ai"]
                state = self.snapshot("--plugin-on", plugin, *flags)
                self.assertEqual(state["services"], {name: owner == plugin for name, owner in owners.items()})
                self.assertEqual(state["degraded"], [])

    def test_reset_clears_data_from_disabled_plugins(self):
        state = self.snapshot("--plugin-off", "light_ai", TEST_PLUGIN_RESET="1")
        self.assertEqual(state["remaining"], [0, 0])

    def test_coarse_with_awareness_off_creates_no_attention_database(self):
        state = self.snapshot("--plugin-off", "screen_awareness", TEST_USER_COARSE="1")
        status, answer = state["coarse"]
        # the revision also counts the clock's own judgments (late_night after 23:00), so only its type is fixed
        self.assertIsInstance(answer.pop("revision"), int)
        self.assertEqual((status, answer), (200, {"presence": "present", "stage": "quiet", "doing": "meeting",
                                                  "absence": None, "typing": True}))
        status, body = state["user_now"]
        self.assertEqual(status, 200)
        self.assertEqual(body["snapshot"]["doing"], "meeting")
        self.assertFalse(state["attention_db"])

    def test_brief_with_no_sources_is_empty(self):
        state = self.snapshot("--plugin-on", "daily_brief", TEST_PLUGIN_BRIEF="1")
        self.assertEqual(state["brief"], "empty")

    def test_unknown_plugin_is_a_start_error(self):
        result = self.run_main("--plugin-on", "not_a_plugin")
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid choice", result.stderr)
        self.assertIn("not_a_plugin", result.stderr)


if __name__ == "__main__":
    probe()
