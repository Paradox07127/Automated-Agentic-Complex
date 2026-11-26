"""Character bindings keep package defaults and change only the selected character's elements."""
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.secrets import MemorySecrets
from brain import persona
from brain.provider import Mouth
from api.handler import Handler
from daemon.agentd_server import AgentdServer
from motion.settings import MotionSettings
from voice.voice_provider import make_provider
import support
import test_server as helpers
import test_speech as speech_helpers

VOICES = {"cedar": None, "birch": ("si", "zh"), "aster": ("voice_a", "zh"),
          "dahlia": None, "elder": None}


def voice_args(cid, url="http://127.0.0.1:9"):
    return Namespace(character=cid, tts_url=url, tts_ensure_host=None, tts_ensure_script=None)


def package_prompt(server, cid, motion):
    """The persona prompt from the package card alone, as rendered before bindings existed."""
    return persona.render_persona(server.characters.load_card(cid), motion)


def bound_prompt(server, cid=None):
    """The persona prompt a turn renders for cid (None: the current character) under its effective binding."""
    from character.binding import bound, effective
    cid = cid or server.character
    return persona.render_persona(*bound(server.characters.load_card(cid), effective(server, cid)))


class BindingCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state_dir = Path(tmp.name)
        self.settings = MotionSettings(self.state_dir, MemorySecrets())
        # Exercise Handler and the real server state without opening a listening socket.
        with mock.patch.object(AgentdServer, "server_bind"), mock.patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 0), helpers.HOOK, support.UI, events_token=helpers.EVENTS)
        self.addCleanup(self.server.server_close)
        self.server.server_port = 9
        self.server.character = "aster"
        self.voices = self.server.characters

    def request_bytes(self, method, path, body=None, token=support.UI):
        raw = b"" if body is None else json.dumps(body).encode()
        headers = (f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nConnection: close\r\n"
                   f"Content-Type: application/json\r\nContent-Length: {len(raw)}\r\n")
        if token:
            headers += f"Authorization: Bearer {token}\r\n"
        output = io.BytesIO()
        connection = mock.Mock()
        connection.makefile.return_value = io.BytesIO(headers.encode() + b"\r\n" + raw)
        connection.sendall.side_effect = output.write
        Handler(connection, ("127.0.0.1", 1), self.server)
        head, _, data = output.getvalue().partition(b"\r\n\r\n")
        return int(head.split()[1]), data

    def request(self, method, path, body=None, token=support.UI):
        status, raw = self.request_bytes(method, path, body, token)
        return status, json.loads(raw)


class PackageDefaultsTest(BindingCase):
    def test_no_file_voice_and_switch_defaults_for_all_five_characters(self):
        self.assertEqual(self.server.characters.ids(), sorted(VOICES))
        for cid, expected in VOICES.items():
            with self.subTest(cid=cid):
                self.assertEqual(self.voices.voice(cid), expected)
                relay = make_provider(voice_args(cid), self.voices, 7, None).relay()
                self.assertEqual((relay.character, relay.language), expected or (cid, "zh"))
                self.server.speech = relay
                with self.server._mouth_lock, self.server._switch_lock:
                    self.server._swap_held(cid, self.server.characters.load_card(cid), None)
                self.assertEqual(self.server.character_voice_enabled, expected is not None)
                self.assertEqual(self.server._text_only("text"), expected is None)
        self.assertFalse((self.state_dir / "character-bindings.json").exists())

    def test_no_file_motion_and_persona_defaults(self):
        self.assertEqual(self.settings.backend, "game")
        for cid in VOICES:
            with self.subTest(cid=cid):
                card = self.server.characters.load_card(cid)
                self.assertEqual(Mouth(character=cid).card, card)
                self.assertNotIn(persona.MOTION_RULE, bound_prompt(self.server, cid))

    def test_no_file_tts_requests_and_c2_stream_bytes(self):
        for cid, expected in VOICES.items():
            with self.subTest(cid=cid):
                relay = make_provider(voice_args(cid), self.voices, 7, "tts-secret").relay()
                self.server.speech = relay
                connection = mock.Mock()

                def response():
                    body = json.loads(connection.request.call_args.args[2])
                    stream = speech_helpers.upstream_lines({**body, "session_epoch": "upstream",
                                                            "turn_id": "upstream"}, cues=True)
                    reply = mock.MagicMock(status=200)
                    reply.__iter__.return_value = [(json.dumps(line) + "\n").encode() for line in stream]
                    return reply

                connection.getresponse.side_effect = response
                with mock.patch.object(relay, "_connection", return_value=connection):
                    utterance = relay.begin_utterance("line-1", generation=0, trace_id="trace-1")
                    relay.add_clause(utterance, "你好。")
                    relay.end_utterance(utterance)
                    lines = speech_helpers.SpeechRelayTest.collect(self, relay, 1)
                method, path, raw, headers = connection.request.call_args.args
                body = json.loads(raw)
                self.assertEqual(method, "POST")
                self.assertEqual(path, "/speech_stream")
                self.assertEqual(headers["Authorization"], "Bearer tts-secret")
                self.assertEqual((body["character"], body["language"]), expected or (cid, "zh"))
                self.assertEqual(body["voice_profile_id"], ".".join((*(expected or (cid, "zh")), "default")))
                self.assertEqual(lines, speech_helpers.upstream_lines(body, cues=True))
                with mock.patch.object(relay, "wait", side_effect=BrokenPipeError):
                    status, raw = self.request_bytes("GET", "/speech?after=0")
                self.assertEqual(status, 200)
                hello, _, speech = raw.partition(b"\n")
                self.assertEqual(json.loads(hello)["event"], "stream.hello")
                self.assertEqual(speech, b"".join((json.dumps({**line, "stream_seq": seq}, ensure_ascii=False)
                                                  + "\n").encode() for seq, line in enumerate(lines, 1)))


class DefaultPromptTest(BindingCase):
    def test_no_file_prompts_match_the_package_cards(self):
        from character.binding import Bindings, effective
        self.server.bindings = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        for backend in ("game", "generated"):
            self.settings.update({"backend": backend})
            for cid in ("aster", "birch"):
                with self.subTest(cid=cid, backend=backend):
                    self.assertEqual(bound_prompt(self.server, cid), package_prompt(self.server, cid, backend == "generated"))
        self.assertFalse((self.state_dir / "character-bindings.json").exists())

    def test_without_bindings_the_prompt_is_the_game_one(self):
        self.settings.update({"backend": "generated"})
        self.assertEqual(bound_prompt(self.server, "aster"), package_prompt(self.server, "aster", False))


class BoundPromptTest(BindingCase):
    IDENTITY = "她是一位刚到岗的测试员。"

    def setUp(self):
        super().setUp()
        from character.binding import Bindings, effective
        self.server.bindings = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        self.server.mouth_factory = lambda cid: Mouth(character=cid)
        self.server.mouth = Mouth(character="aster")
        self.server.mouth.refresh_system(effective(self.server))  # as main() does once the bindings exist

    def text(self):
        return bound_prompt(self.server)

    def instructions(self):
        from character.binding import bound, effective
        return bound(self.server.characters.load_card(self.server.character), effective(self.server))[0]["post_history_instructions"]

    def test_a_generated_binding_follows_its_character_through_switches(self):
        self.assertNotIn(persona.MOTION_RULE, self.text())
        self.assertEqual(self.request("PUT", "/characters/aster/binding",
                                      {"revision": 0, "motion": {"driver": "generated"}})[0], 200)
        self.assertEqual(self.settings.backend, "game")
        self.assertIn(persona.MOTION_RULE, self.text())
        self.assertTrue(self.server.set_character("birch"))
        self.assertEqual(self.text(), package_prompt(self.server, "birch", False))
        status, opened = self.server.prepare_switch("aster")
        self.assertEqual(status, 200)
        self.assertEqual(self.server.commit_switch(opened["switch_id"])[0], 200)
        self.assertEqual(self.server.character, "aster")
        self.assertIn(persona.MOTION_RULE, self.text())

    def test_a_persona_override_reaches_the_next_turn_prompt(self):
        overrides = {"identity": self.IDENTITY, "post_history_instructions": "回答控制在两句以内。"}
        self.assertEqual(self.request("PUT", "/characters/aster/binding",
                                      {"revision": 0, "persona": {"overrides": overrides}})[0], 200)
        self.assertIn(f"<identity>\n{self.IDENTITY}\n</identity>", self.text())
        self.assertNotIn(persona.MOTION_RULE, self.text())
        self.assertNotIn(self.IDENTITY, persona.render_persona(self.server.characters.load_card("aster")))
        from character.binding import bound, effective
        card, motion = bound(self.server.characters.load_card("aster"), effective(self.server))
        self.assertEqual((card["identity"], card["post_history_instructions"], motion),
                         (self.IDENTITY, overrides["post_history_instructions"], "game"))
        self.assertEqual(self.request("PUT", "/characters/aster/binding", {"revision": 1, "persona": None})[0], 200)
        self.assertEqual(self.text(), package_prompt(self.server, "aster", False))

    def test_bound_tells_the_generated_rule_the_game_rule_and_none_apart(self):
        from character.binding import bound
        card = self.server.characters.load_card("aster")
        binding = {"motion": {"driver": "generated"}, "persona": {"overrides": {}}}
        self.assertEqual(bound(card, None), (card, False))
        self.assertEqual(bound(card, binding), (card, True))
        self.assertEqual(bound(card, {**binding, "motion": {"driver": "game"}}), (card, "game"))

    def test_a_bound_field_outlives_the_package_translation(self):
        from character.binding import bound
        mine = [{"user": "早", "reply": "早上好。"}]
        card = {"tone_rules": ["包里的"], "catchphrases": [], "examples": [{"user": "嗨", "reply": "嗯。"}],
                "i18n": {"en": {"tone_rules": ["package en"], "catchphrases": [{"phrase": "Hm", "when": "always"}]}}}
        binding = {"motion": {"driver": "game"}, "persona": {"overrides": {"tone_rules": ["我自己的"], "examples": mine}}}
        for language in ("en", "ja"):
            english = persona.localized(bound(card, binding)[0], language)
            self.assertEqual((english["tone_rules"], english["examples"]), (["我自己的"], mine))
        english = persona.localized(bound(card, binding)[0], "en")
        self.assertEqual(english["catchphrases"], [{"phrase": "Hm", "when": "always"}])
        self.assertEqual(card["i18n"]["en"]["tone_rules"], ["package en"])

    def test_post_history_override_reaches_the_mouth(self):
        self.server.mouth = Mouth(character="aster", lore_path=False)
        instructions = "回答控制在两句以内。"
        path = "/characters/aster/binding"
        self.assertEqual(self.request("PUT", path, {
            "revision": 0, "persona": {"overrides": {"post_history_instructions": instructions}}})[0], 200)
        self.assertEqual(self.instructions(), instructions)
        self.assertEqual(self.request("PUT", path, {"revision": 1, "persona": None})[0], 200)
        self.assertEqual(self.instructions(), self.server.mouth.card["post_history_instructions"])

    def test_another_characters_binding_leaves_the_current_mouth(self):
        before = self.text()
        self.assertEqual(self.request("PUT", "/characters/cedar/binding", {
            "revision": 0, "motion": {"driver": "generated"}, "persona": {"overrides": {"identity": self.IDENTITY}}})[0], 200)
        self.assertEqual(self.text(), before)
        self.server.mouth = helpers.FakeMouth([])
        self.assertEqual(self.request("PUT", "/characters/birch/binding",
                                      {"revision": 1, "motion": {"driver": "generated"}})[0], 200)
        self.assertEqual(self.server.mouth.refreshed, 0)

    def test_a_voice_only_change_does_not_refresh(self):
        self.server.mouth = helpers.FakeMouth([])
        self.assertEqual(self.request("PUT", "/characters/aster/binding", {
            "revision": 0, "voice": {"voice_id": "custom", "language": "ja"}, "motion": {"driver": "game"}})[0], 200)
        self.assertEqual(self.server.mouth.refreshed, 0)


class BindingDefaultsTest(PackageDefaultsTest):
    def setUp(self):
        super().setUp()
        from character.binding import Bindings, effective
        self.voices = self.server.bindings = Bindings(self.state_dir, self.server.characters,
                                                     lambda: self.settings.backend)


class BindingsTest(BindingCase):
    def setUp(self):
        super().setUp()
        from character.binding import Bindings, effective
        self.bindings = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        self.path = self.state_dir / "character-bindings.json"

    def test_defaults_and_live_global_motion(self):
        for cid, voice in VOICES.items():
            with self.subTest(cid=cid):
                self.assertEqual(self.bindings.effective(cid), {
                    "character_id": cid, "revision": 0,
                    "voice": None if voice is None else {"voice_id": voice[0], "language": voice[1], "source": "package"},
                    "motion": {"driver": "game", "source": "global"},
                    "persona": {"overrides": {}, "source": "package"}})
        self.settings.update({"backend": "generated"})
        self.assertEqual(self.bindings.effective("aster")["motion"], {"driver": "generated", "source": "global"})
        self.assertFalse(self.path.exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_update_persists_only_overrides_and_preserves_absent_keys(self):
        from character.binding import Bindings, effective
        voice = {"voice_id": "custom", "language": "ja"}
        motion = {"driver": "generated"}
        overrides = {"identity": "a custom identity", "post_history_instructions": "stay brief"}
        status, reply = self.bindings.update("aster", {"revision": 0, "voice": voice, "motion": motion,
                                                      "persona": {"overrides": overrides}})
        self.assertEqual(status, 200)
        self.assertEqual(reply, {"character_id": "aster", "revision": 1,
                                 "voice": {**voice, "source": "user"}, "motion": {**motion, "source": "user"},
                                 "persona": {"overrides": overrides, "source": "user"}})
        self.assertEqual(self.settings.backend, "game")
        self.assertEqual(self.bindings.update("cedar", {"revision": 1, "motion": {"driver": "game"}})[0], 200)
        self.assertEqual(self.bindings.update("aster", {"revision": 2})[1]["revision"], 3)
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(saved, {"revision": 3, "characters": {
            "aster": {"voice": voice, "motion": motion, "persona": {"overrides": overrides}},
            "cedar": {"motion": {"driver": "game"}}}})
        loaded = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        self.assertEqual(loaded.effective("aster"), {**reply, "revision": 3})
        self.assertEqual(loaded.voice("aster"), ("custom", "ja"))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_null_resets_each_key_and_uses_current_defaults(self):
        self.bindings.update("aster", {"revision": 0, "voice": {"voice_id": "custom", "language": "en"},
                                       "motion": {"driver": "game"}, "persona": {"overrides": {"identity": "custom"}}})
        self.settings.update({"backend": "generated"})
        self.assertEqual(self.bindings.effective("aster")["motion"], {"driver": "game", "source": "user"})
        for revision, key in enumerate(("voice", "motion", "persona"), 1):
            with self.subTest(key=key):
                status, reply = self.bindings.update("aster", {"revision": revision, key: None})
                self.assertEqual(status, 200)
                self.assertNotIn(key, json.loads(self.path.read_text(encoding="utf-8"))["characters"].get("aster", {}))
        self.assertEqual(reply, {"character_id": "aster", "revision": 4,
                                 "voice": {"voice_id": "voice_a", "language": "zh", "source": "package"},
                                 "motion": {"driver": "generated", "source": "global"},
                                 "persona": {"overrides": {}, "source": "package"}})

    def test_invalid_payloads(self):
        bodies = [None, [], "bad", {}, {"revision": True}, {"revision": 0.0}, {"revision": "0"},
                  {"revision": 0, "harness": "codex"}, {"revision": 0, "model": "global"},
                  {"revision": 0, "voice": {}}, {"revision": 0, "voice": []},
                  {"revision": 0, "voice": {"voice_id": "custom", "language": "zh", "source": "user"}},
                  {"revision": 0, "motion": {}}, {"revision": 0, "motion": "game"},
                  {"revision": 0, "motion": {"driver": "game", "backend": "game"}},
                  {"revision": 0, "persona": {}}, {"revision": 0, "persona": []},
                  {"revision": 0, "persona": {"overrides": {}, "name": "new"}}]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.bindings.update("aster", body), (400, {"error": "invalid_payload"}))
        self.assertFalse(self.path.exists())

    def test_invalid_voice_values(self):
        for key in ("voice_id", "language"):
            for value in (None, 1, True, [], {}, "", "v" * 65):
                with self.subTest(key=key, value=value):
                    voice = {"voice_id": "custom", "language": "zh", key: value}
                    self.assertEqual(self.bindings.update("aster", {"revision": 0, "voice": voice}),
                                     (400, {"error": "invalid_voice"}))
        self.assertFalse(self.path.exists())

    def test_voice_string_limits(self):
        value = "声" * 64
        voice = {"voice_id": value, "language": value}
        self.assertEqual(self.bindings.update("aster", {"revision": 0, "voice": voice})[0], 200)
        self.assertEqual(self.bindings.voice("aster"), (value, value))

    def test_invalid_motion_values(self):
        for driver in ("other", "", None, [], {}, True):
            with self.subTest(driver=driver):
                self.assertEqual(self.bindings.update("aster", {"revision": 0, "motion": {"driver": driver}}),
                                 (400, {"error": "invalid_motion_driver"}))
        self.assertFalse(self.path.exists())

    def test_persona_override_keys_and_types(self):
        overrides = [None, [], {"name": "new"}, {"tts": {}}, {"identity": []}, {"knowledge": []},
                     {"tone_rules": {}}, {"catchphrases": "x"}, {"post_history_instructions": None},
                     {"familiarity_rules": []}, {"markers": "x"}]
        for values in overrides:
            with self.subTest(overrides=values):
                self.assertEqual(self.bindings.update("aster", {"revision": 0, "persona": {"overrides": values}}),
                                 (400, {"error": "invalid_persona_override"}))
        self.assertFalse(self.path.exists())

    def test_persona_render_failures(self):
        for values in ({"knowledge": {}}, {"catchphrases": [{}]}, {"examples": [None]}):
            with self.subTest(overrides=values):
                self.assertEqual(self.bindings.update("aster", {"revision": 0, "persona": {"overrides": values}}),
                                 (400, {"error": "invalid_persona_override"}))
        card = self.server.characters.load_card("aster")
        del card["name"]
        with mock.patch.object(self.server.characters, "load_card", return_value=card):
            self.assertEqual(self.bindings.update("aster", {"revision": 0, "persona": {"overrides": {}}}),
                             (400, {"error": "invalid_persona_override"}))
        self.assertFalse(self.path.exists())

    def test_persona_sections_and_optional_familiarity(self):
        before = self.server.characters.load_card("aster")
        overrides = {key: deepcopy(before[key]) for key in (*persona.SECTIONS, "post_history_instructions")}
        overrides["familiarity_rules"] = "only discuss shared facts"
        without_optional = {key: value for key, value in before.items() if key != "familiarity_rules"}
        with mock.patch.object(self.server.characters, "load_card", return_value=without_optional):
            status, reply = self.bindings.update("aster", {"revision": 0, "persona": {"overrides": overrides}})
        self.assertEqual(status, 200)
        self.assertEqual(reply["persona"], {"overrides": overrides, "source": "user"})
        self.assertEqual(self.server.characters.load_card("aster"), before)

    def test_persona_serialized_value_limit(self):
        for revision, text in enumerate(("a" * 19998, "知" * 19998)):
            self.assertEqual(len(json.dumps(text, ensure_ascii=False)), 20000)
            self.assertEqual(self.bindings.update("aster", {"revision": revision,
                             "persona": {"overrides": {"identity": text}}})[0], 200)
        before = self.path.read_bytes()
        for value in ("a" * 19999, "\n" * 10000):
            self.assertEqual(self.bindings.update("aster", {"revision": 2, "persona": {"overrides": {"identity": value}}}),
                             (400, {"error": "invalid_persona_override"}))
        self.assertEqual(self.path.read_bytes(), before)

    def test_unknown_character_and_record_bound(self):
        for cid in ("unknown", "../aster"):
            with self.subTest(cid=cid):
                self.assertEqual(self.bindings.update(cid, {"revision": 0}), (404, {"error": "unknown_character"}))
                with self.assertRaises(ValueError):
                    self.bindings.effective(cid)
        self.assertFalse(self.path.exists())
        for revision, cid in enumerate(list(VOICES) * 2):
            self.assertEqual(self.bindings.update(cid, {"revision": revision, "motion": {"driver": "game"}})[0], 200)
        self.assertEqual(set(json.loads(self.path.read_text(encoding="utf-8"))["characters"]), set(VOICES))

    def test_stale_revision_is_global_and_does_not_write(self):
        self.bindings.update("aster", {"revision": 0, "voice": {"voice_id": "custom", "language": "en"}})
        before = self.path.read_bytes()
        for cid in ("aster", "cedar"):
            for revision in (0, -1, 2):
                with self.subTest(cid=cid, revision=revision):
                    self.assertEqual(self.bindings.update(cid, {"revision": revision, "voice": None}),
                                     (409, {"error": "revision_conflict", "revision": 1}))
        self.assertEqual(self.path.read_bytes(), before)

    def test_concurrent_compare_and_set_has_one_winner(self):
        ready = threading.Barrier(2)

        def write(cid):
            ready.wait(timeout=5)
            return self.bindings.update(cid, {"revision": 0, "motion": {"driver": "generated"}})

        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(write, ("cedar", "aster")))
        self.assertEqual(sorted(status for status, _ in replies), [200, 409])
        self.assertEqual([reply for status, reply in replies if status == 409],
                         [{"error": "revision_conflict", "revision": 1}])
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual((saved["revision"], len(saved["characters"])), (1, 1))

    def test_callers_cannot_change_records_without_a_revision(self):
        body = {"revision": 0, "persona": {"overrides": {"tone_rules": ["be brief"]}}}
        _, reply = self.bindings.update("aster", body)
        body["persona"]["overrides"]["tone_rules"].append("from caller")
        reply["persona"]["overrides"]["tone_rules"].append("from reply")
        self.bindings.effective("aster")["persona"]["overrides"]["tone_rules"].clear()
        self.assertEqual(self.bindings.effective("aster")["persona"]["overrides"], {"tone_rules": ["be brief"]})


class BindingRoutesTest(BindingCase):
    def setUp(self):
        super().setUp()
        from character.binding import Bindings, effective
        self.server.bindings = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        self.server.speech = helpers.FakeRelay()
        self.server.speech.character, self.server.speech.language = "voice_a", "zh"
        self.server.mouth = helpers.FakeMouth([])
        self.server.mouth.history = [["user", "context", "reply"]]

    def test_get_and_put_round_trip(self):
        path = "/characters/aster/binding"
        self.assertEqual(self.request("GET", path), (200, self.server.bindings.effective("aster")))
        status, reply = self.request("PUT", path, {"revision": 0, "motion": {"driver": "generated"},
                                                "persona": {"overrides": {"identity": "custom"}}})
        self.assertEqual(status, 200)
        self.assertEqual(reply["revision"], 1)
        self.assertEqual(self.request("GET", path), (200, reply))
        self.assertEqual(self.settings.backend, "game")
        self.assertEqual(self.server.mouth.refreshed, 1)

    def test_routes_before_bindings_exist(self):
        del self.server.bindings
        for method in ("GET", "PUT"):
            self.assertEqual(self.request(method, "/characters/aster/binding", {"revision": 0}),
                             (503, {"error": "no_bindings"}))

    def test_unknown_character_and_path_limits(self):
        for method in ("GET", "PUT"):
            self.assertEqual(self.request(method, "/characters/unknown/binding", {"revision": 0}),
                             (404, {"error": "unknown_character"}))
            for cid in ("a-b_1", "a" * 64):
                self.assertEqual(self.request(method, f"/characters/{cid}/binding", {"revision": 0}),
                                 (404, {"error": "unknown_character"}))
            for cid in ("", "a" * 65, "Aster", "a/b"):
                self.assertEqual(self.request(method, f"/characters/{cid}/binding", {"revision": 0}),
                                 (404, {"error": "not_found"}))

    def test_only_ui_token_can_read_and_write(self):
        for method in ("GET", "PUT"):
            for token in (None, helpers.HOOK, helpers.EVENTS):
                with self.subTest(method=method, token=token):
                    self.assertEqual(self.request(method, "/characters/aster/binding", {"revision": 0}, token),
                                     (401, {"error": "unauthorized"}))

    def test_current_voice_put_and_reset_update_the_live_relay(self):
        path = "/characters/aster/binding"
        self.assertEqual(self.request("PUT", path, {"revision": 0, "voice": {"voice_id": "custom", "language": "ja"}})[0], 200)
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("custom", "ja"))
        self.assertTrue(self.server.character_voice_enabled)
        self.assertEqual(self.request("PUT", path, {"revision": 1, "voice": None})[0], 200)
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("voice_a", "zh"))
        self.assertEqual(self.server.mouth.refreshed, 0)
        self.assertEqual(self.server.mouth.history, [["user", "context", "reply"]])

    def test_other_character_voice_does_not_change_current_speech(self):
        self.assertEqual(self.request("PUT", "/characters/cedar/binding", {
            "revision": 0, "voice": {"voice_id": "custom", "language": "en"}})[0], 200)
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("voice_a", "zh"))
        self.assertEqual(self.server.character, "aster")
        self.assertTrue(self.server.character_voice_enabled)
        self.assertEqual(self.server.bindings.voice("cedar"), ("custom", "en"))

    def test_voice_on_silent_character_enables_speech_and_reset_disables_it(self):
        with self.server._mouth_lock, self.server._switch_lock:
            self.server._swap_held("cedar", self.server.characters.load_card("cedar"), None)
        self.assertFalse(self.server.character_voice_enabled)
        path = "/characters/cedar/binding"
        self.assertEqual(self.request("PUT", path, {"revision": 0, "voice": {"voice_id": "custom", "language": "en"}})[0], 200)
        self.assertTrue(self.server.character_voice_enabled)
        self.assertFalse(self.server._text_only("text"))
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("custom", "en"))
        self.assertEqual(self.request("PUT", path, {"revision": 1, "voice": None})[0], 200)
        self.assertFalse(self.server.character_voice_enabled)
        self.assertTrue(self.server._text_only("text"))

    def test_failed_put_leaves_speech_unchanged(self):
        path = "/characters/aster/binding"
        for body, error in ((None, "invalid_payload"), ({"revision": 0, "voice": {"voice_id": 1, "language": "zh"}}, "invalid_voice")):
            self.assertEqual(self.request("PUT", path, body), (400, {"error": error}))
        self.assertEqual(self.request("PUT", path, {"revision": 1, "voice": None}),
                         (409, {"error": "revision_conflict", "revision": 0}))
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("voice_a", "zh"))

    def test_switch_and_provider_use_persisted_user_voice(self):
        from character.binding import Bindings, effective
        self.server.bindings.update("birch", {"revision": 0, "voice": {"voice_id": "custom", "language": "ja"}})
        self.server.bindings = Bindings(self.state_dir, self.server.characters, lambda: self.settings.backend)
        relay = make_provider(voice_args("birch"), self.server.bindings, 7, None).relay()
        self.assertEqual((relay.character, relay.language), ("custom", "ja"))
        with self.server._mouth_lock, self.server._switch_lock:
            self.server._swap_held("birch", self.server.characters.load_card("birch"), None)
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("custom", "ja"))
        self.assertTrue(self.server.character_voice_enabled)

    def test_put_without_speech_relay(self):
        self.server.speech = None
        self.assertEqual(self.request("PUT", "/characters/aster/binding", {
            "revision": 0, "voice": {"voice_id": "custom", "language": "en"}})[0], 200)
        self.assertIsNone(self.server.speech)


if __name__ == "__main__":
    unittest.main()
