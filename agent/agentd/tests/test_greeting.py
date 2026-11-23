"""Her opening line once the first-run guide is done (POST /character/greeting)."""
import unittest
from unittest.mock import Mock, patch

import support
import test_route_registry
import test_server
from daemon.agentd_server import AgentdServer


class GreetingTest(unittest.TestCase):
    request = test_route_registry.ProactiveRoutesTest.request
    wait_for = test_server.RitualTapTest.wait_for

    def setUp(self):
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), "hook-token", support.UI)
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        self.server.speech = test_server.FakeRelay()
        self.server.mouth = test_server.FakeMouth(["A model reply."])
        self.server.desk = Mock()
        self.agent = self.server.character_agent = test_server.KernelLines(self.server)
        self.agent.settings.snapshot = lambda: {"reply_language": "auto"}
        self.agent.reply_language.observe("auto", "I am speaking English.")
        self.card = {"lines": {"greeting_morning": [{"en": "Good to see you today."}]}}
        self.server.characters.load_card = lambda cid: self.card

    def greet(self):
        status, response = self.request("POST", "/character/greeting", {})
        self.assertEqual(status, 202, response)
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        lines = [item["data"] for item in self.server.feed.since(0)
                 if item["event"] == "line" and item["data"]["line_id"] == response["line_id"]]
        self.assertTrue(lines and lines[-1]["final"] and not lines[-1]["cancelled"], lines)
        self.assertIsNone(lines[-1]["error"])
        return lines

    def test_without_her_voice_the_card_greeting_is_only_shown_and_counts_for_the_daily_brief(self):
        self.server.character_voice_enabled = False
        lines = self.greet()
        self.assertEqual("".join(line["text_delta"] for line in lines), "Good to see you today.")
        self.assertFalse(any(line["speak"] for line in lines))
        self.assertEqual([c for c in self.server.speech.calls if c[0] == "speak"], [])
        self.assertEqual(self.server.mouth.calls, [])
        self.server.desk.count.assert_called_once_with("greet")

    def test_a_card_without_a_greeting_has_the_model_make_one(self):
        self.card = {}
        lines = self.greet()
        self.assertEqual("".join(line["text_delta"] for line in lines), "A model reply.")
        [(prompt, _)] = self.server.mouth.calls
        self.assertIn("opening line", prompt)

    def test_only_an_empty_body_is_taken(self):
        self.assertEqual(self.request("POST", "/character/greeting", {"text": "hi"}), (400, {"error": "invalid_payload"}))
        self.assertFalse(any(i["event"] == "line" for i in self.server.feed.since(0)))


if __name__ == "__main__":
    unittest.main()
