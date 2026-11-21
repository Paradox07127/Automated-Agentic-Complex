import http.client
import io
import unittest
import unittest.mock

import support

from api.handler import Handler  # noqa: E402
from character_agent.routes import task_understanding_http  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402

HOOK, UI = "hook-token", "ui-token"


class InternalErrorTest(unittest.TestCase):
    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    request = support.request

    def test_uncaught_exception_answers_500_with_route_and_logs_traceback(self):
        cases = (("GET", "/state?x=1", None, "/state"),
                 ("POST", "/say", {"text": "hi"}, "/say"),
                 ("PUT", "/observation/paused", {"minutes": 5}, "/observation/paused"),
                 ("PATCH", "/memory/facts/f1", {"text": "x"}, "/memory/facts/f1"),
                 ("DELETE", "/attention", None, "/attention"))
        for method, path, body, bare in cases:
            with self.subTest(method=method), \
                    unittest.mock.patch.object(Handler, "_dispatch", side_effect=KeyError("boom")), \
                    unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                status, data = self.request(method, path, body)
                self.assertEqual(status, 500)
                self.assertEqual(data, {"error": "internal_error", "route": f"{method} {bare}"})
                self.assertIn("Traceback", stderr.getvalue())
                self.assertIn("KeyError: 'boom'", stderr.getvalue())

    def test_snapshot_part_failure_answers_500_for_the_snapshot(self):
        def route(_handler, _method, path):
            if path == "/task-understanding":
                raise KeyError("boom")
            return False
        with unittest.mock.patch.object(task_understanding_http, "route", side_effect=route), \
                unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status, data = self.request("GET", "/agent/snapshot")
        self.assertEqual((status, data), (500, {"error": "internal_error", "route": "GET /agent/snapshot"}))
        self.assertIn("KeyError: 'boom'", stderr.getvalue())
        self.assertNotIn("AttributeError", stderr.getvalue())

    def test_connection_stays_usable_after_500(self):
        with unittest.mock.patch.object(Handler, "_dispatch", side_effect=KeyError("boom")), \
                unittest.mock.patch("sys.stderr", new_callable=io.StringIO):
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            conn.request("GET", "/state", headers={"Authorization": f"Bearer {UI}"})
            first = conn.getresponse()
            first.read()
        conn.request("GET", "/state", headers={"Authorization": f"Bearer {UI}"})
        second = conn.getresponse()
        second.read()
        conn.close()
        self.assertEqual((first.status, second.status), (500, 200))


if __name__ == "__main__":
    unittest.main()
