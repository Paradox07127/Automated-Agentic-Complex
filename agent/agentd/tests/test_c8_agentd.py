"""Shared C8 examples through agentd's reader and tool dispatcher.

Not checked by agentd (validate.py checks these): excluding boolean v; known
frame types; ready fields other than capabilities; text_delta/item/plan/result/
interrupted/error payload schemas; optional tool_request metadata types; and
agentd-to-runner payload schemas. Tool identifiers/name/args go through
the dispatcher. The reader queues pre-ready data; startup discards it.
Increasing seq is not enforced as an error: agentd drops replays.
"""
import contextvars
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.codex_transport import CodexConfig, ManagedCodexSession

# Every bridged harness config names the directory its own tools work in.
WORK = {"workspace_dir": tempfile.gettempdir(), "native_tools": True}

EXAMPLES = Path(__file__).resolve().parents[3] / "protocol/C8-harness-runner/examples"
TO_RUNNER = {"init", "query", "tool_result", "permission_result", "interrupt", "close"}


class AgentdExamplesTests(unittest.TestCase):
    def read_example(self, path):
        lines = path.read_bytes().splitlines(keepends=True)
        frames = [json.loads(line) for line in lines]
        session = ManagedCodexSession(CodexConfig(".", "fixture", **WORK), frames[0]["tools"])
        replies = {f["tool_call_id"]: f for f in frames if f["type"] == "tool_result"}
        requests = [f for f in frames if f["type"] == "tool_request"]
        handler = Mock(spec=[], side_effect=[replies[f["tool_call_id"]]["result"] for f in requests])
        answers = [f for f in frames if f["type"] == "permission_result"]
        permission = Mock(spec=[], side_effect=[f["option_id"] for f in answers])
        query = next((f for f in frames if f["type"] == "query"), None)
        if query:
            session._active = {"id": query["run_id"], "cancelled": False, "cancel_signal": None,
                               "handler": handler, "permission_handler": permission, "deadline": time.monotonic() + 10,
                               "context": contextvars.copy_context()}
        incoming = [(n, raw, frame) for n, (raw, frame) in enumerate(zip(lines, frames), 1)
                    if frame["type"] not in TO_RUNNER]
        proc = SimpleNamespace(stdout=io.BytesIO(b"".join(raw for _, raw, _ in incoming)),
                               stdin=io.BytesIO(), poll=lambda: None)
        with patch.object(session, "_terminate") as terminate, \
                patch("character_agent.harness.transport.threading.Thread") as worker:
            # Run the real tool dispatcher synchronously so queue order is deterministic.
            worker.side_effect = lambda **kwargs: SimpleNamespace(start=lambda: kwargs["target"](*kwargs.get("args", ())))
            session._read(proc, session._generation)
        events = []
        while not session._events.empty():
            events.append(session._events.get_nowait())
        written = [f for f in frames if f["type"] in ("tool_result", "permission_result")]
        return incoming, events, proc.stdin.getvalue(), handler, terminate, written

    def test_ok_examples(self):
        paths = sorted(EXAMPLES.glob("ok-*.ndjson"))
        self.assertEqual([p.name for p in paths], ["ok-acp-permission.ndjson", "ok-acp.ndjson", "ok-codex.ndjson", "ok-pi.ndjson"])
        for path in paths:
            with self.subTest(example=path.name):
                incoming, events, written, handler, terminate, replies = self.read_example(path)
                self.assertEqual(events.pop(), {"type": "eof"})
                for line, _, frame in incoming:
                    event = events.pop(0)
                    where = f"{path.name}:{line}"
                    if frame["type"] == "tool_request":
                        self.assertEqual(event["type"], "tool_started", where)
                        self.assertEqual((event["name"], event["args"]), (frame["name"], frame["args"]), where)
                        self.assertEqual(events.pop(0)["type"], "tool_finished", where)
                        handler.assert_any_call(frame["name"], frame["args"])
                    elif frame["type"] == "permission_request":
                        self.assertEqual(event["type"], "permission_requested", where)
                        self.assertEqual(event["request_id"], frame["request_id"], where)
                    else:
                        self.assertEqual(event, frame, where)
                terminate.assert_not_called()
                self.assertEqual(events, [])
                self.assertEqual([json.loads(raw) for raw in written.splitlines()], replies)
                self.assertEqual(handler.call_count, sum(r["type"] == "tool_result" for r in replies))

    def test_bad_examples(self):
        paths = sorted(EXAMPLES.glob("bad-*.ndjson"))
        self.assertEqual([p.name for p in paths], ["bad-capability-missing-key.ndjson",
            "bad-capability-value.ndjson", "bad-no-capabilities.ndjson", "bad-seq-repeat.ndjson", "bad-v.ndjson"])
        for path in paths:
            with self.subTest(example=path.name):
                incoming, events, written, handler, terminate, _ = self.read_example(path)
                if path.name == "bad-seq-repeat.ndjson":
                    self.assertEqual(events, [incoming[0][2], {"type": "eof"}])
                    terminate.assert_not_called()
                else:
                    self.assertEqual(events, [{"type": "error", "code": "runner_protocol_error",
                        "message": "Invalid harness response"}, {"type": "eof"}])
                    terminate.assert_called_once()
                self.assertEqual(written, b"")
                handler.assert_not_called()


if __name__ == "__main__": unittest.main()
