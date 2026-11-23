"""agentd-error.jsonl: the envelope and its folding, route errors, failed turns, speech failures and missing grants."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import unittest.mock

import support
from api.handler import Handler
from character_agent.harness.transport import HarnessError
from daemon.agentd_server import AgentdServer
from observation.blacklist import Blacklist
from observation.capture import CaptureManager
from daemon.error_record import ErrorLog, failure
import test_trace_server
from test_turn import relay_for, wait_for

HOOK, UI = "hook-token", support.UI


def records(lines):
    return [json.loads(line) for line in lines]


class ErrorLogTest(unittest.TestCase):
    def setUp(self):
        self.lines, self.now = [], 1000.0
        self.log = ErrorLog(self.lines.append, clock=lambda: self.now)

    def test_the_first_record_goes_out_at_once_and_repeats_within_a_minute_fold_into_a_count(self):
        for _ in range(3):
            self.log.record("http_4xx", "GET /x 404", req="GET /x")
            self.now += 10
        self.assertEqual(records(self.lines), [{"t": "1970-01-01T00:16:40.000Z", "component": "agentd",
                                                "code": "http_4xx", "message": "GET /x 404", "req": "GET /x",
                                                "count": 1}])
        self.now += 31
        self.log.flush()
        self.assertEqual([(r["t"], r["count"]) for r in records(self.lines)],
                         [("1970-01-01T00:16:40.000Z", 1), ("1970-01-01T00:17:00.000Z", 2)])
        self.log.flush()
        self.assertEqual(len(self.lines), 2)

    def test_another_message_is_a_line_of_its_own_and_exit_writes_every_held_count(self):
        self.log.record("timeout", "text turn failed: TimeoutError", turn_id="l1", trace_id="t1")
        self.log.record("timeout", "voice turn failed: TimeoutError", turn_id="l2")
        self.log.record("timeout", "text turn failed: TimeoutError", turn_id="l3", trace_id="t3")
        self.assertEqual(len(self.lines), 2)
        self.log.flush(everything=True)
        last = records(self.lines)[-1]
        self.assertEqual((last["turn_id"], last["trace_id"], last["count"]), ("l3", "t3", 1))
        self.assertEqual(self.log.open, {})

    def test_message_and_detail_are_cut(self):
        self.log.record("internal_error", "m" * 400, detail="d" * 600)
        [record] = records(self.lines)
        self.assertEqual((len(record["message"]), len(record["detail"])), (300, 500))


class FailureCodeTest(unittest.TestCase):
    def test_exceptions_become_kernel_codes_with_their_class_as_message(self):
        class Status(Exception):
            def __init__(self, status):
                self.status_code = status
        for error, expected in ((TimeoutError("read timed out"), ("timeout", "TimeoutError")),
                                ("TimeoutError", ("timeout", "TimeoutError")),
                                (HarnessError("TimeoutError"), ("timeout", "TimeoutError")),
                                (ConnectionRefusedError(), ("network", "ConnectionRefusedError")),
                                (subprocess.CalledProcessError(3, ["claude"]), ("cli_exit_3", "CalledProcessError")),
                                (Status(401), ("auth_expired", "Status")), (Status(429), ("rate_limited", "Status")),
                                (KeyError("x"), ("unknown", "KeyError")), (None, ("unknown", "unknown"))):
            with self.subTest(error=error):
                self.assertEqual(failure(error), expected)

    def test_a_code_agentd_already_names_stays(self):
        for error in ("select_model", HarnessError("run_timeout"), "cancelled"):
            code = error if isinstance(error, str) else error.code
            self.assertEqual(failure(error), (code, code))


class RouteErrorTest(unittest.TestCase):
    def setUp(self):
        support.enable_plugins(self)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.lines = []
        self.server.errors = ErrorLog(self.lines.append)
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    request = support.request

    def test_a_4xx_is_recorded_with_route_status_and_code_but_no_body_or_query_value(self):
        self.assertEqual(self.request("GET", "/brief/day?date=secret-day"), (400, {"error": "invalid_date"}))
        self.assertGreaterEqual(self.request("PATCH", "/memory/facts/fact-secret", {"text": "秘密的话"})[0], 400)
        self.assertEqual(self.request("GET", "/no/such/route?token=abc")[0], 404)
        self.assertEqual(self.request("GET", "/state", token=None)[0], 401)
        found = records(self.lines)
        self.assertEqual([(r["code"], r["message"], r.get("req")) for r in found][0],
                         ("invalid_date", "GET /brief/day 400", "GET /brief/day"))
        self.assertTrue(found[1]["message"].startswith("PATCH /memory/facts/"))
        self.assertEqual([(r["code"], r["message"]) for r in found[2:]],
                         [("not_found", "GET - 404"), ("unauthorized", "GET /state 401")])
        text = "".join(self.lines)
        for secret in ("secret-day", "fact-secret", "秘密", "token=abc"):
            self.assertNotIn(secret, text)

    def test_an_uncaught_exception_is_one_internal_error_record_with_its_class_and_first_line(self):
        with unittest.mock.patch.object(Handler, "_dispatch", side_effect=RuntimeError("boom\nsecond line")), \
                unittest.mock.patch("sys.stderr"):
            self.assertEqual(self.request("GET", "/state?x=1")[0], 500)
        [record] = records(self.lines)
        self.assertEqual((record["code"], record["message"], record["req"]),
                         ("internal_error", "GET /state: RuntimeError: boom", "GET /state"))


class TurnErrorTest(test_trace_server.TraceServerCase):
    def setUp(self):
        super().setUp()
        self.lines = []
        self.server.errors = ErrorLog(self.lines.append)

    def test_a_failed_turn_has_its_kernel_code_and_message_in_trace_and_record(self):
        def timed_out(text, context):
            raise TimeoutError("read timed out after the user's words")
            yield
        self.server.mouth.stream = timed_out
        said = self.line("你好")
        turn = self.only_turn()
        [settled] = self.of(self.events(turn["trace_id"]), "turn.settled")
        self.assertEqual((settled["status"], settled["attrs"]["error_code"], settled["attrs"]["error_message"]),
                         ("failed", "timeout", "TimeoutError"))
        self.assertEqual(turn["error_code"], "timeout")
        [record] = records(self.lines)
        self.assertEqual({k: record[k] for k in ("code", "message", "turn_id", "trace_id")},
                         {"code": "timeout", "message": "text turn failed: TimeoutError",
                          "turn_id": said["line_id"], "trace_id": turn["trace_id"]})
        self.assertNotIn("你好", self.lines[0])
        self.assertNotIn("read timed out", self.lines[0])

    def test_a_turn_whose_clauses_all_fail_records_one_speech_failure_with_host_and_status(self):
        tts, relay = relay_for(self, status=503)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        self.use_mouth(["今天天气很好，适合出去走走。", "我们去公园看看花吧，那边人不多。", "回来再一起喝杯茶。"])
        said = self.line("你好")
        turn = self.only_turn()
        self.assertTrue(wait_for(lambda: len(self.of(self.events(turn["trace_id"]), "speech.finished")) >= 2))
        self.assertTrue(wait_for(lambda: not relay.busy()))
        self.server.errors.flush(everything=True)
        failed = [r for r in records(self.lines) if r["code"] == "speech_failed"]
        self.assertEqual([(r["message"], r["turn_id"], r["count"]) for r in failed],
                         [("http_503 from 127.0.0.1", said["line_id"], 1)])


class PermissionRecordTest(unittest.TestCase):
    def setUp(self):
        support.enable_plugins(self)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.server.capture = CaptureManager(self.server.feed, Blacklist(support.deny_blacklist(Path(tmp.name) / "b.json")),
                                             lambda: None, None, share_text=True)
        self.lines = []
        self.server.errors = ErrorLog(self.lines.append)
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    request = support.request

    def test_a_capture_the_shell_reports_denied_names_the_grant(self):
        self.request("POST", "/context/image", {"request_id": "r-1", "window_id": 7, "url_host": None,
                                                "error": "permission_denied"})
        denied = [r for r in records(self.lines) if r["code"] == "permission_denied"]
        self.assertEqual([r["message"] for r in denied], ["screen_recording denied: window capture"])


if __name__ == "__main__":
    unittest.main()
