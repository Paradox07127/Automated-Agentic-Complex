import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import support
import test_route_registry
import test_server
from brain.characters import Repository
from character_tool import compose
from character_library import digest, write_json
from daemon.agentd_server import AgentdServer
from infra.store import open_store
from personal.rituals import Rituals
from test_character_library import text_fixture
from test_rituals import at

ROOT = Path(__file__).resolve().parents[3]


class CardLinesTest(unittest.TestCase):
    def test_sample_includes_localized_choices_for_each_event(self):
        card = Repository(ROOT / "characters/sample-library/current.json").load_card("aide")
        source = json.loads((ROOT / "characters/sample-character/persona/card.json").read_text(encoding="utf-8"))
        self.assertEqual(card, source)
        for event in ("tap", "head_pat", "gift", "greeting_morning", "greeting_back", "idle", "dragged"):
            with self.subTest(event=event):
                for lang in ("en", "zh-Hans", "ja"):
                    self.assertGreaterEqual(len({line[lang] for line in card.get("lines", {}).get(event, [])}), 2)

    def test_malformed_lines_are_rejected_at_load(self):
        for lines in ([], {"tap": [{}]}, {"tap": "Hi"}, {"tap": [{"en": 1}]}):
            with self.subTest(lines=lines), tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / "source"
                definition = text_fixture(source)
                path = source / "persona/card.json"
                card = json.loads(path.read_text(encoding="utf-8"))
                write_json(path, {**card, "lines": lines})
                definition["components"]["persona"]["card"].update(sha256=digest(path), byte_count=path.stat().st_size)
                write_json(source / "character.json", definition)
                library = Path(tmp) / "library"
                compose([source], "aide", library)
                with self.assertRaisesRegex(ValueError, "lines"):
                    Repository(library / "current.json").load_card("aide")


class ScriptedLinesTest(unittest.TestCase):
    request = test_route_registry.ProactiveRoutesTest.request
    wait_for = test_server.RitualTapTest.wait_for

    def setUp(self):
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), "hook-token", support.UI)
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        self.server.speech = test_server.FakeRelay()
        self.server.mouth = test_server.FakeMouth(["A model reply."])
        self.agent = self.server.character_agent = test_server.KernelLines(self.server)
        self.agent.settings.snapshot = lambda: {"reply_language": "auto"}
        self.agent.reply_language.observe("auto", "I am speaking English.")
        self.offline = patch.object(self.agent, "public", return_value={"routes": {"chat": {"ready": False}}})
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.card = {"lines": {"tap": [{"en": "Hello.", "ja": "こんにちは。"}, {"en": "I'm here."}, {"ja": "はい。"}],
                               "head_pat": [{"en": "That feels nice."}], "gift": [{"en": "Thank you."}],
                               "greeting_back": [{"en": "Welcome back."}], "greeting_morning": [{"en": "Good morning."}]}}
        self.server.characters.load_card = lambda cid: self.card

    def delivered(self, line_id):
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        lines = [item["data"] for item in self.server.feed.since(0)
                 if item["event"] == "line" and item["data"]["line_id"] == line_id]
        self.assertTrue(lines and lines[-1]["final"] and not lines[-1]["cancelled"], lines)
        self.assertIsNone(lines[-1]["error"])
        return "".join(line["text_delta"] for line in lines)

    def tap(self, **body):
        status, response = self.request("POST", "/interaction/tap", body)
        self.assertEqual(status, 202, response)
        return self.delivered(response["line_id"])

    def test_offline_taps_speak_in_the_pinned_language_without_repeating(self):
        choices = {line["en"] for line in self.card["lines"]["tap"] if "en" in line}
        first, second = self.tap(), self.tap()
        self.assertEqual({first, second}, choices)
        self.assertEqual([c[2] for c in self.server.speech.calls if c[0] == "speak"], [first, second])
        self.assertEqual(self.server.mouth.calls, [])

    def test_head_pat_works_without_a_mouth(self):
        self.server.mouth = None
        self.assertEqual(self.tap(region="head_top"), "That feels nice.")

    def test_morning_greeting_settles_before_the_next_tap(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = open_store(Path(tmp) / "agentd.sqlite")
            try:
                self.server.rituals = Rituals(db, clock=lambda: at(8))
                self.assertEqual(self.tap(), "Good morning.")
                self.assertEqual([row["kind"] for row in self.server.rituals.today()], ["morning"])
                self.assertIn(self.tap(), ("Hello.", "I'm here."))
            finally:
                self.server.rituals = None
                db.close()

    def test_gift_answers_with_the_same_line_id_as_the_bubble(self):
        status, gift = self.request("POST", "/interaction/gift", {})
        self.assertEqual(status, 202)
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        states = [i["data"] for i in self.server.feed.since(0) if i["event"] == "gift"]
        self.assertEqual([g["state"] for g in states], ["queued", "answered"])
        self.assertEqual(states[-1]["gift_id"], gift["gift_id"])
        self.assertEqual(self.delivered(states[-1]["line_id"]), "Thank you.")
        self.assertEqual(self.server.mouth.calls, [])

    def test_eligible_welcome_back_uses_the_card(self):
        self.assertTrue(self.server.claim_line("returned", "Welcome the user back.", lambda: True,
                                               {"code": "back", "kind": "back"}))
        self.assertEqual(self.delivered("returned"), "Welcome back.")
        self.assertEqual(self.server.mouth.calls, [])

    def test_a_ready_model_still_receives_the_tap_prompt(self):
        self.offline.stop()
        self.assertEqual(self.tap(), "A model reply.")
        self.assertEqual(len(self.server.mouth.calls), 1)

    def test_offline_card_without_a_matching_line_keeps_the_old_response(self):
        for card in ({}, {"lines": {"tap": [{"ja": "はい。"}]}}):
            with self.subTest(card=card):
                self.card = card
                self.assertEqual(self.request("POST", "/interaction/tap", {}), (200, {"kind": None}))
        self.server.mouth = None
        self.assertEqual(self.request("POST", "/interaction/tap", {}), (503, {"error": "no_llm"}))
        self.assertFalse(any(i["event"] == "line" for i in self.server.feed.since(0)))

    def test_cheek_pinch_uses_its_own_lines_and_falls_back_to_tap(self):
        self.card = {**self.card, "lines": {**self.card["lines"], "cheek_pinch": [{"en": "Hey, my cheek!"}]}}
        self.assertEqual(self.tap(region="cheek_l"), "Hey, my cheek!")
        self.card = {"lines": {"tap": [{"en": "Hello."}]}}
        self.assertEqual(self.tap(region="cheek_r"), "Hello.")

    def test_offline_gift_without_scripted_line_fails_instead_of_staying_queued(self):
        self.card = {}
        status, gift = self.request("POST", "/interaction/gift", {})
        self.assertEqual(status, 202)
        states = [i["data"] for i in self.server.feed.since(0) if i["event"] == "gift"]
        self.assertEqual([(g["state"], g.get("reason")) for g in states], [("queued", None), ("failed", "no_llm")])
        self.assertIsNone(self.server._gift_pending)
