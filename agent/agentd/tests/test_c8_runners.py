"""Real C8 emitters with SDK/app-server substitutes; no model or network.

These check example frame shapes, not SDK compatibility or every C8 lifecycle rule.
Python runners execute in-process; Pi executes under Node with a fixture SDK.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

HERE = Path(__file__).resolve().parent
PROTOCOL = HERE.parents[2] / "protocol/C8-harness-runner"
sys.path.insert(0, str(HERE.parent))
from character_agent.harness import codex_runner
from character_agent.harness.pi_config import pi_runner_environment

_spec = importlib.util.spec_from_file_location("c8_validate", PROTOCOL / "validate.py")
c8 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c8)


def example(test, name):
    lines = (PROTOCOL / "examples" / name).read_text(encoding="utf-8").splitlines(keepends=True)
    # Subset matching alone cannot detect a required key removed from the example.
    test.assertIsNone(c8.check(lines), name)
    return [(n, json.loads(raw)) for n, raw in enumerate(lines, 1)]


def assert_frame(test, name, line, expected, actual):
    where = f"{name}:{line}"
    test.assertEqual(actual.get("type"), expected["type"], where)
    for key, value in expected.items():
        test.assertIn(key, actual, f"{where}: {key}")
        expected_type = "number" if type(value) in (int, float) else type(value)
        actual_type = "number" if type(actual[key]) in (int, float) else type(actual[key])
        test.assertEqual(actual_type, expected_type, f"{where}: {key}")


class PythonRunnerExamplesTests(unittest.IsolatedAsyncioTestCase):
    async def replay(self, subject, name, frames):
        output, emitted = asyncio.Queue(), []
        stdout = SimpleNamespace(buffer=SimpleNamespace(write=lambda raw: output.put_nowait(json.loads(raw)),
                                                         flush=lambda: None))
        task = None
        with patch.object(codex_runner.sys, "stdout", stdout):
            try:
                for line, frame in frames:
                    kind = frame["type"]
                    if kind == "init":
                        await subject.initialize(frame)
                    elif kind == "query":
                        if task:
                            await asyncio.wait_for(task, 2)
                        subject.active = {"id": frame["run_id"], "cancelled": False}
                        task = asyncio.create_task(subject.run(frame))
                    elif kind == "tool_result":
                        subject.pending[frame["tool_call_id"]][1].set_result(frame)
                    elif kind == "interrupt":
                        await subject.interrupt(frame["run_id"])
                    elif kind == "close":
                        await asyncio.wait_for(task, 2)
                        await subject.client.disconnect()
                    else:
                        actual = await asyncio.wait_for(output.get(), 2)
                        assert_frame(self, name, line, frame, actual)
                        emitted.append(actual)
                self.assertTrue(output.empty(), f"{name}: runner emitted extra frames")
                self.assertIsNone(c8.check([json.dumps(f) + "\n" for f in emitted]), name)
            finally:
                if task and not task.done():
                    task.cancel()
                    await task

    async def test_codex_example(self):
        name = "ok-codex.ndjson"
        frames = example(self, name)
        subject = codex_runner.CodexRunner()
        client = SimpleNamespace(start=AsyncMock(), write=AsyncMock(), disconnect=AsyncMock(),
                                 proc=SimpleNamespace(pid=4343), events=asyncio.Queue())
        client.next_event = client.events.get

        async def notifications():
            def send(method, **params):
                client.events.put_nowait({"method": method, "params": {
                    "threadId": "thread-1", "turnId": "turn-1", **params}})
            send("turn/plan/updated", explanation=None, plan=[{"step": "Read the fixture", "status": "inProgress"}])
            send("item/started", item={"id": "item_fixture", "type": "dynamicToolCall", "tool": "fixture_read"})
            await asyncio.sleep(0)
            result = await subject.server_request("item/tool/call", {"threadId": "thread-1", "turnId": "turn-1",
                "tool": "fixture_read", "arguments": {}, "callId": "call_fixture", "itemId": "item_fixture"})
            self.assertEqual(json.loads(result["contentItems"][0]["text"]), {"checked": True})
            send("item/completed", item={"id": "item_fixture", "type": "dynamicToolCall", "tool": "fixture_read"})
            send("item/completed", item={"id": "msg_fixture", "type": "agentMessage",
                                        "phase": "final_answer", "text": "Synthetic result verified."})
            send("thread/tokenUsage/updated", tokenUsage={"total": {"inputTokens": 2, "outputTokens": 3}})
            send("turn/completed", turn={"id": "turn-1", "status": "completed"})

        feed = None
        async def request(method, params):
            nonlocal feed
            if method == "turn/start":
                feed = asyncio.create_task(notifications())
                return {"turn": {"id": "turn-1"}}
            return {"initialize": {}, "config/read": {"config": {}},
                    "thread/start": {"thread": {"id": "thread-1"}}}[method]
        client.request = AsyncMock(side_effect=request)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(codex_runner, "AppServer", return_value=client), \
                patch.object(subject, "_command", AsyncMock(side_effect=["codex-cli 0.166.0",
                    json.dumps({"models": [{"slug": "gpt-6.1-sol"}]}), "[]"])):
            frames[0][1]["config"].update(state_dir=directory, cli_path=sys.executable)
            try:
                await self.replay(subject, name, frames)
                await asyncio.wait_for(feed, 2)
            finally:
                if feed and not feed.done():
                    feed.cancel()
                    await asyncio.gather(feed, return_exceptions=True)


class CodexLogDatabaseTests(unittest.IsolatedAsyncioTestCase):
    DATABASE = ("logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm")

    async def test_log_database_lives_only_as_long_as_the_runner_process(self):
        subject = codex_runner.CodexRunner()
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory) / "logs"
            logs.mkdir()
            for name in self.DATABASE + ("keep.txt",):
                (logs / name).write_text("turn content", encoding="utf-8")
            seen = {}

            async def start():
                seen["at_launch"] = sorted(path.name for path in logs.iterdir())
                (logs / "logs_2.sqlite").write_text("tool result", encoding="utf-8")

            async def disconnect():
                seen["at_exit"] = (logs / "logs_2.sqlite").exists()

            client = SimpleNamespace(start=AsyncMock(side_effect=start), write=AsyncMock(),
                                     disconnect=AsyncMock(side_effect=disconnect), proc=SimpleNamespace(pid=4343),
                                     request=AsyncMock(side_effect=lambda method, params: {
                                         "initialize": {}, "config/read": {"config": {}},
                                         "thread/start": {"thread": {"id": "thread-1"}}}[method]))
            subject.read = lambda loop: None
            subject.queue.put_nowait({"type": "init", "tools": [], "config": {
                "state_dir": directory, "model": "gpt-6.1-sol", "cli_path": sys.executable}})
            subject.queue.put_nowait({"type": "close"})
            stdout = SimpleNamespace(buffer=SimpleNamespace(write=lambda raw: None, flush=lambda: None))
            with patch.object(codex_runner.sys, "stdout", stdout), \
                    patch.object(codex_runner, "AppServer", return_value=client), \
                    patch.object(subject, "_command", AsyncMock(side_effect=["codex-cli 0.166.0",
                        json.dumps({"models": [{"slug": "gpt-6.1-sol"}]}), "[]"])):
                await asyncio.wait_for(subject.main(), 5)
            self.assertEqual(seen["at_launch"], ["keep.txt"])
            self.assertTrue(seen["at_exit"])
            self.assertEqual(sorted(path.name for path in logs.iterdir()), ["keep.txt"])

    def test_discarding_tolerates_a_missing_directory_and_removes_links_not_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            codex_runner.discard_log_db(root)
            (root / "logs").mkdir()
            target = root / "target.sqlite"
            target.write_text("elsewhere", encoding="utf-8")
            (root / "logs" / "logs_2.sqlite").symlink_to(target)
            (root / "logs" / "logs_3.sqlite-wal").mkdir()
            codex_runner.discard_log_db(root)
            self.assertFalse((root / "logs" / "logs_2.sqlite").is_symlink())
            self.assertEqual(target.read_text(encoding="utf-8"), "elsewhere")
            self.assertTrue((root / "logs" / "logs_3.sqlite-wal").is_dir())


PI_AUTH_STORAGE = '''
export const AuthStorage = { create() {}, inMemory: () => ({ list: async () => [] }) };
'''
PI_SDK = '''
export const ModelRuntime = { create: async () => ({ registerProvider() {},
  setRuntimeApiKey: async () => {}, getModels: () => [], getModel: () => ({ input: ["text"] }) }) };
export const SettingsManager = { inMemory: value => value };
export const SessionManager = { inMemory: () => ({}) };
export const createExtensionRuntime = () => ({});
export async function createAgentSession({ customTools }) {
  let notify;
  const session = {
    sessionId: "pi-session-1", getActiveToolNames: () => customTools.map(t => t.name),
    subscribe: callback => { notify = callback; }, abort: async () => {}, dispose() {},
    async prompt() {
      notify({ type: "turn_start" });
      notify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
        content: [{ type: "toolCall" }], usage: { input: 10, output: 5 } } });
      const reply = await customTools[0].execute("call-0", { id: "e1" });
      if (reply.content[0].text !== "Readback confirmed.") throw new Error("missing_receipt");
      notify({ type: "turn_start" });
      notify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checked." } });
      notify({ type: "message_end", message: { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: "Checked." }], usage: { input: 10, output: 5 } } });
    }
  };
  return { session };
}
'''


class PiRunnerExampleTests(unittest.TestCase):
    def test_pi_example(self):
        name = "ok-pi.ndjson"
        frames = example(self, name)
        node = shutil.which("node")
        self.assertIsNotNone(node, "C8 Pi example test requires Node >= 22.19")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "node_modules/@earendil-works/pi-coding-agent"
            (package / "dist").mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"type": "module", "version": "0.9.0"}), encoding="utf-8")
            (package / "dist/index.js").write_text(PI_SDK, encoding="utf-8")
            (package / "dist/core").mkdir()
            (package / "dist/core/auth-storage.js").write_text(PI_AUTH_STORAGE, encoding="utf-8")
            frames[0][1]["config"].update(state_dir=directory, runtime_dir=directory,
                provider="endfield-fixture", auth_source="none", base_url="http://127.0.0.1",
                max_turns=24, max_budget_usd=1, tool_timeout=2)
            proc = subprocess.Popen([node, str(HERE.parent / "character_agent/harness/pi_runner.mjs")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                env=pi_runner_environment(root))
            emitted, lines = [], queue.Queue()

            def read():
                for raw in proc.stdout:
                    lines.put(raw)
                lines.put(b"")
            threading.Thread(target=read, daemon=True).start()
            try:
                for line, frame in frames:
                    if frame["type"] in c8.TO_RUNNER:
                        proc.stdin.write((json.dumps(frame) + "\n").encode())
                        proc.stdin.flush()
                    else:
                        try:
                            raw = lines.get(timeout=5)
                        except queue.Empty:
                            self.fail(f"{name}:{line}: runner did not emit a frame")
                        self.assertTrue(raw, f"{name}:{line}: runner exited before this frame")
                        actual = json.loads(raw)
                        assert_frame(self, name, line, frame, actual)
                        emitted.append(actual)
                self.assertEqual(proc.wait(timeout=5), 0, proc.stderr.read().decode())
                self.assertEqual(lines.get(timeout=5), b"", f"{name}: runner emitted extra frames")
                self.assertIsNone(c8.check([json.dumps(f) + "\n" for f in emitted]), name)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.communicate(timeout=5)


if __name__ == "__main__": unittest.main()
