"""Process-boundary regressions; fake runner, deliberately no model claims."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.acp_transport import AcpConfig, ManagedAcpSession
from character_agent.harness.codex_transport import CodexConfig
from character_agent.harness.transport import (CAPABILITIES, MAX_FRAME, PROTOCOL_VERSION, HarnessError,
    ManagedClaudeSession, runner_environment)

# Every bridged harness config names the directory its own tools work in.
WORK = {"workspace_dir": tempfile.gettempdir(), "native_tools": True}

_spec = importlib.util.spec_from_file_location(
    "c8_validate", Path(__file__).resolve().parents[3] / "protocol/C8-harness-runner/validate.py")
c8 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c8)

FAKE_RUNNER = r'''
import json,signal,sys,time
n=0
queries=0
pending=None
late=None
stubborn=False
def ask(rid):
 send(dict(type='permission_request',run_id=rid,request_id='perm-'+str(queries),title='Edit notes',kind='edit',
  locations=['/work/notes.txt'],raw_input={'path':'/work/notes.txt'},
  options=[dict(option_id='allow-once',name='Allow once',kind='allow_once')]))
def send(event):
 global n
 n+=1
 print(json.dumps(dict(v=1,seq=n,**event)),flush=True)
for raw in sys.stdin:
 m=json.loads(raw)
 if m['type']=='init':
  caps={} if m['system_prompt']=='no-capabilities' else dict(capabilities=dict(cancel='process_kill',
   tool_injection='in_process',builtin_tools='unverified',system_prompt='prompt_prefix',usage='none',
   event_scope='global',native_questions=False))
  bad=dict(bad_value=('cancel','maybe'),bad_bool=('native_questions',1)).get(m['system_prompt'])
  if bad: caps['capabilities'][bad[0]]=bad[1]
  if m['system_prompt']=='missing-key': del caps['capabilities']['usage']
  if m['system_prompt']=='stubborn': signal.signal(signal.SIGTERM,signal.SIG_IGN)
  stubborn=m['system_prompt']=='stubborn'
  send(dict(type='ready',session_id=None,tool_names=[x['name'] for x in m['tools']],**caps))
 elif m['type']=='query':
  queries+=1
  rid=m['run_id']
  if m['prompt']=='bad-frame':
   print('not json',flush=True)
  elif m['prompt']=='wait':
   pending=rid
  elif m['prompt']=='tool':
   pending=rid
   send(dict(type='tool_request',run_id=rid,tool_call_id='call-'+str(queries),name='fixture',args={'query':queries}))
  elif m['prompt']=='permission':
   pending=rid
   ask(rid)
  elif m['prompt']=='permission-after-cancel':
   pending=late=rid
  elif m['prompt']=='old-event':
   send(dict(type='text_delta',run_id='previous',text='must not show'))
   send(dict(type='result',run_id=rid,success=True,subtype='success',session_id='session'))
  else:
   send(dict(type='text_delta',run_id=rid,text=json.dumps({'query':queries,'history':m.get('history')})))
   send(dict(type='result',run_id=rid,success=True,subtype='success',session_id='session'))
 elif m['type']=='tool_result':
  if pending==m['run_id']:
   send(dict(type='text_delta',run_id=pending,text=json.dumps(m['result'])))
   send(dict(type='result',run_id=pending,success=not m['is_error'],subtype='success',session_id='session'))
   pending=None
 elif m['type']=='permission_result':
  if late==m['run_id']:
   send(dict(type='result',run_id=late,success=False,subtype='cancelled',session_id='session',text=json.dumps(m)))
   late=None
  elif pending==m['run_id']:
   send(dict(type='text_delta',run_id=pending,text=json.dumps(m)))
   send(dict(type='result',run_id=pending,success=True,subtype='success',session_id='session'))
   pending=None
 elif m['type']=='interrupt':
  if late==m['run_id']:
   ask(late)
   continue
  send(dict(type='result',run_id=m['run_id'],success=False,subtype='cancelled',session_id='session'))
  pending=None
 elif m['type']=='close' and not stubborn:
  break
'''


class ManagedTransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runner = self.root / "fake_runner.py"
        self.runner.write_text(FAKE_RUNNER, encoding="utf-8")
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            session.close()
        self.tmp.cleanup()

    def session(self, permission_handler=None, **config):
        cfg = CodexConfig(str(self.root / "state"), "fixture-model", "fixture-key", cli_path="/fixture/codex", **config, **WORK)
        session = ManagedClaudeSession(cfg, [{"name": "fixture", "description": "Test only",
                                              "input_schema": {"type": "object"}}],
                                      lambda name, args: {"answer": args["query"]}, permission_handler,
                                      runner_path=self.runner)
        self.sessions.append(session)
        return session

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_same_process_reused_and_history_only_in_first_query(self):
        session = self.session()
        a = list(session.stream("hello", system_prompt="persona", history=[["user", "answer"]]))
        pid = session.pid
        b = list(session.stream("again", system_prompt="persona", history=[["duplicate"]]))
        self.assertEqual(session.pid, pid)
        self.assertEqual(json.loads(a[1]["text"]), {"query": 1, "history": [["user", "answer"]]})
        self.assertEqual(json.loads(b[1]["text"]), {"query": 2, "history": None})
        self.assertEqual(b[-1]["session_id"], "session")

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_persona_change_and_invalidation_start_new_session(self):
        session = self.session()
        list(session.stream("hello", system_prompt="one"))
        pid = session.pid
        result = list(session.stream("hello", system_prompt="two"))
        self.assertNotEqual(pid, session.pid)
        self.assertEqual(json.loads(result[1]["text"])["query"], 1)
        session.invalidate()
        self.assertIsNone(session.pid)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_per_run_tool_handler_replaces_stale_scope_closure(self):
        session = self.session()
        first = list(session.stream("tool", system_prompt="persona", tool_handler=lambda n,a: {"scope": "one"}))
        second = list(session.stream("tool", system_prompt="persona", tool_handler=lambda n,a: {"scope": "two"}))
        self.assertEqual([e["result"] for e in first if e["type"] == "tool_finished"], [{"scope": "one"}])
        self.assertEqual([e["result"] for e in second if e["type"] == "tool_finished"], [{"scope": "two"}])
        self.assertTrue(second[-1]["success"])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_interrupt_reaches_runner_while_tool_is_blocked(self):
        session = self.session()
        entered, release, cancel = threading.Event(), threading.Event(), threading.Event()
        results = []
        def tool(_name, _args):
            entered.set()
            release.wait(5)
            return {"effect": "late"}
        def consume():
            results.extend(session.stream("tool", system_prompt="persona", cancelled=cancel, tool_handler=tool))
        worker = threading.Thread(target=consume)
        worker.start()
        self.assertTrue(entered.wait(2))
        start = time.monotonic()
        cancel.set()
        worker.join(2)
        release.set()
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic()-start, 2)
        self.assertEqual(results[-1]["subtype"], "cancelled")
        self.assertFalse(results[-1]["success"])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_context_handler_gets_original_call_id_once_and_typeerror_is_not_retried(self):
        calls = []
        def handler(_name, _args):
            raise AssertionError("Context-aware handler must be selected before invoking")
        def contextual(name, args, context):
            calls.append((name, args, context))
            raise TypeError("Synthetic domain failure after an effect")
        handler.call_with_context = contextual
        events = list(self.session().stream("tool", system_prompt="persona", run_id="run-fixture", tool_handler=handler))
        self.assertEqual(calls, [("fixture", {"query": 1}, {"tool_call_id": "call-1", "run_id": "run-fixture"})])
        self.assertFalse(events[-1]["success"])

    PERMISSION = {"run_id": "run-p", "request_id": "perm-1", "title": "Edit notes", "kind": "edit",
                  "locations": ["/work/notes.txt"], "raw_input": {"path": "/work/notes.txt"},
                  "options": [{"option_id": "allow-once", "name": "Allow once", "kind": "allow_once"}]}

    def permission_reply(self, events):
        return json.loads(next(e["text"] for e in events if e["type"] == "text_delta"))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_permission_handler_answer_is_returned_to_runner(self):
        seen = []
        session = self.session(permission_handler=lambda request: seen.append(request) or "allow-once")
        events = list(session.stream("permission", system_prompt="persona", run_id="run-p"))
        self.assertEqual(seen, [self.PERMISSION])
        self.assertIn({"type": "permission_requested", **self.PERMISSION}, events)
        self.assertEqual(self.permission_reply(events), {"v": 1, "type": "permission_result", "run_id": "run-p",
                                                         "request_id": "perm-1", "option_id": "allow-once"})
        self.assertTrue(events[-1]["success"])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_permission_without_handler_is_answered_null(self):
        events = list(self.session().stream("permission", system_prompt="persona", run_id="run-p"))
        self.assertIn({"type": "permission_requested", **self.PERMISSION}, events)
        self.assertIsNone(self.permission_reply(events)["option_id"])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_permission_request_after_cancel_is_answered_null(self):
        calls, cancel = [], threading.Event()
        stream = self.session().stream("permission-after-cancel", system_prompt="persona", run_id="run-c",
                                       cancelled=cancel, permission_handler=lambda r: calls.append(r) or "allow-once")
        self.assertEqual(next(stream)["type"], "ready")
        cancel.set()
        events = list(stream)
        self.assertEqual(calls, [])
        self.assertNotIn("permission_requested", [e["type"] for e in events])
        self.assertEqual((events[-1]["subtype"], json.loads(events[-1]["text"])["option_id"]), ("cancelled", None))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_second_stream_cannot_write_active_session(self):
        session = self.session()
        cancel = threading.Event()
        it = session.stream("wait", system_prompt="persona", cancelled=cancel)
        self.assertEqual(next(it)["type"], "ready")
        with self.assertRaisesRegex(HarnessError, "run_busy"):
            list(session.stream("hello", system_prompt="persona"))
        it.close()

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_malformed_runner_fails_without_exposing_raw_content(self):
        session = self.session()
        with self.assertRaisesRegex(HarnessError, "Invalid harness response"):
            list(session.stream("bad-frame", system_prompt="persona"))
        self.assertIsNone(session.pid)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_ready_capabilities_are_kept_on_the_session(self):
        session = self.session()
        self.assertIsNone(session.capabilities)
        ready = session.probe("persona")
        self.assertEqual(session.capabilities, ready["capabilities"])
        self.assertEqual(session.capabilities["cancel"], "process_kill")

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_ready_without_capabilities_is_a_protocol_error(self):
        session = self.session()
        with self.assertRaises(HarnessError) as raised:
            session.probe("no-capabilities")
        self.assertEqual(raised.exception.code, "runner_protocol_error")
        self.assertIsNone(session.pid)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_ready_with_capabilities_outside_c8_is_a_protocol_error(self):
        for prompt in ("bad_value", "bad_bool", "missing-key"):
            with self.subTest(prompt):
                session = self.session()
                with self.assertRaises(HarnessError) as raised:
                    session.probe(prompt)
                self.assertEqual(raised.exception.code, "runner_protocol_error")
                self.assertIsNone(session.pid)

    def test_c8_validator_uses_the_wire_constants(self):
        self.assertEqual((c8.PROTOCOL_VERSION, c8.MAX_FRAME, c8.CAPABILITIES),
                         (PROTOCOL_VERSION, MAX_FRAME, CAPABILITIES))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_stale_run_events_do_not_reach_current_user(self):
        events = list(self.session().stream("old-event", system_prompt="persona"))
        self.assertFalse(any(e["type"] == "text_delta" for e in events))
        self.assertTrue(events[-1]["success"])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_caller_timeout_reaps_runner(self):
        session = self.session()
        with self.assertRaisesRegex(HarnessError, "run_timeout"):
            list(session.stream("wait", system_prompt="persona", timeout=0.15))
        self.assertIsNone(session.pid)

    @unittest.skipIf(sys.platform == "win32", "the fake runner ignores SIGTERM")
    def test_close_returns_before_a_stubborn_runner_is_reaped(self):
        acp = AcpConfig(str(self.root / "acp"), "", "fixture-agent", [sys.executable], python=sys.executable, **WORK)
        for session in (self.session(), ManagedAcpSession(acp, runner_path=self.runner)):
            with self.subTest(type(session).__name__):
                self.sessions.append(session)
                list(session.stream("hello", system_prompt="stubborn"))
                proc = session._proc
                start = time.monotonic()
                session.close()
                self.assertLess(time.monotonic() - start, 0.2)
                self.assertIsNone(proc.poll())
                self.assertEqual(proc.wait(timeout=15), -9)

    @unittest.skipIf(sys.platform == "win32", "the fake runner ignores SIGTERM")
    def test_job_actor_next_runner_waits_for_the_last_ones_cleanup(self):
        actor = self.root / "character-agent/runner/codex/jobs/job-1"
        first = self.session()
        first.config = CodexConfig(str(actor), "fixture-model", "fixture-key", cli_path="/fixture/codex", **WORK)
        list(first.stream("hello", system_prompt="stubborn"))
        old = first._proc
        first.close()
        second = self.session()
        second.config = first.config
        events = list(second.stream("hello", system_prompt="persona"))
        self.assertIsNotNone(old.returncode)
        self.assertTrue(events[-1]["success"])
        self.assertTrue((actor / ".session.lock").exists())

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_closing_generator_discards_unconsumed_sdk_turn(self):
        session = self.session()
        stream = session.stream("hello", system_prompt="persona")
        next(stream)
        self.assertEqual(next(stream)["type"], "text_delta")
        stream.close()
        self.assertIsNone(session.pid)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_cancelled_input_does_not_start_runner(self):
        session = self.session()
        cancel = threading.Event(); cancel.set()
        result = list(session.stream("hello", system_prompt="persona", cancelled=cancel))
        self.assertIsNone(session.pid)
        self.assertEqual(result[-1]["subtype"], "cancelled")

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_runner_inherits_the_user_environment_but_not_endfield_tokens(self):
        config = CodexConfig(self.root, "model", "fixture-API-KEY", cli_path="/fixture/codex", **WORK)
        self.assertNotIn("fixture-API-KEY", repr(config))
        self.assertNotIn("fixture-API-KEY", json.dumps(config.public()))
        user = {"ANTHROPIC_AUTH_TOKEN": "user-token", "OPENAI_API_KEY": "user-key", "AWS_PROFILE": "work",
                "CLAUDE_CODE_USE_BEDROCK": "1", "HTTPS_PROXY": "https://proxy.example", "PATH": "/opt/user/bin:/usr/bin"}
        with patch.dict(os.environ, {**user, "AGENTD_HOOK_TOKEN": "internal", "AAC_CODEX_API_KEY": "endfield-key",
                                     "AAC_TTS_TOKEN_FILE": "/endfield/tts.token", "CODEX_HOME": "/native-profile"}):
            env = runner_environment(self.root / "isolated")
        self.assertLessEqual(user.items(), env.items())
        for key in ("AGENTD_HOOK_TOKEN", "AAC_CODEX_API_KEY", "AAC_TTS_TOKEN_FILE", "CODEX_HOME"):
            self.assertNotIn(key, env)
        self.assertEqual(Path(env["TMPDIR"]), (self.root / "isolated/tmp").resolve())
        for child in ("tmp", "workspace"):
            self.assertEqual((self.root / "isolated" / child).stat().st_mode & 0o777, 0o700)

    def test_invalid_credentials_and_api_url_are_rejected_before_spawn(self):
        with self.assertRaisesRegex(ValueError, "credentials_missing"):
            CodexConfig(self.root, "model", cli_path="/fixture/codex", **WORK).validate()
        for url in ("http://example.com", "https://user:pass@api.openai.com", "https://api.openai.com?key=x"):
            with self.assertRaisesRegex(ValueError, "invalid_api_url"):
                CodexConfig(self.root, "model", "key", cli_path="/fixture/codex", base_url=url, **WORK).validate()


if __name__ == "__main__":
    unittest.main()
