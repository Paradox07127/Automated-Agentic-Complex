"""PUT /settings/live: the settings the launch arguments set take effect without a restart."""
import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.handler import Handler  # noqa: E402
from brain.egress import EgressPolicy  # noqa: E402
from character.behavior import Behavior  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.proactive import Proactive  # noqa: E402
from character_agent.services.semantic import SemanticVision  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from daemon.main import build_capture  # noqa: E402
from infra import plugins  # noqa: E402
from observation.facing_decisions import FacingDecisions  # noqa: E402
from observation.spatial import Spatial  # noqa: E402
from traces.motion_lane import MotionLane  # noqa: E402
import support  # noqa: E402

# what an agentd started without arguments runs with
DEFAULTS = {"mute": False, "proactive_speech": True, "interaction_preset": "balanced", "redact_sensitive": True,
            "share_page_text": False, "share_window_text": False, "share_typed_text": False,
            "share_agent_sessions": False, "share_screenshots": False}
NOON = datetime.datetime(2026, 11, 23, 12, 0)
SWITCHES = {"share_page_text": "page_text", "share_window_text": "window_text", "share_typed_text": "typed_text",
            "share_agent_sessions": "agent_sessions", "share_screenshots": "screenshots"}
PLUGINS = {"share_page_text": "screen_awareness", "share_typed_text": "screen_awareness",
           "share_agent_sessions": "coding_sessions"}


class LiveSettingsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            self.server = server = AgentdServer(("127.0.0.1", 48810), "hook-token", support.UI,
                                                events_token="events-token", gate=Gate(enabled=True))
        server.server_port = 48810
        self.addCleanup(server.server_close)
        self.addCleanup(server._stopped.set)
        server.behavior = Behavior(lambda: {}, lambda *_: None)
        server.facing_decisions = FacingDecisions(None, lambda *_: None, 180)
        server.proactive = Proactive(None, server.gate, lambda *_: None, lambda *_, **__: None, lambda: False,
                                     break_minutes=60, water_minutes=90)
        server.egress = EgressPolicy()
        server.character_agent = SimpleNamespace(semantic=object(), cancel=lambda reason: None, close=lambda: None)
        server.capture = build_capture(server.feed, None, None, self.tmp, False, False)
        self.plugins(True)

    def plugins(self, on):
        enabled = patch.dict(plugins.resolved, {"screen_awareness": on, "coding_sessions": on})
        enabled.start()
        self.addCleanup(enabled.stop)

    def request(self, body, token=support.UI, raw=None):
        payload = raw if raw is not None else json.dumps(body).encode()
        auth = "" if token is None else f"Authorization: Bearer {token}\r\n"
        head = (f"PUT /settings/live HTTP/1.1\r\nHost: 127.0.0.1:48810\r\n{auth}"
                f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n").encode()
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(head + payload), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        return int(headers.split()[1]), json.loads(response)

    def put(self, **changes):
        self.assertEqual(self.request({**DEFAULTS, **changes}), (200, {"ok": True}))

    def state(self):
        s = self.server
        return {"interaction": (s.interaction, s.gate.interaction, s.gate.enabled, s.gate.same_cooldown,
                                s.spatial.interaction, s.behavior.interaction, s.facing_decisions.interval),
                "muted": s.muted,
                "redact": s.egress.observed("a@b.example"), "consent": s.consent.snapshot()[0],
                "vision": s.capture.vision}

    def test_a_body_that_is_not_exactly_the_settings_answers_400_and_changes_nothing(self):
        self.put(interaction_preset="active", mute=True, share_window_text=True)
        before = self.state()
        missing = dict(DEFAULTS)
        del missing["mute"]
        wrong = [("mute", 1), ("mute", None), ("proactive_speech", "true"), ("interaction_preset", "unlimited"),
                 ("interaction_preset", None), ("redact_sensitive", 0), ("share_page_text", "yes"),
                 ("share_window_text", None), ("share_typed_text", []), ("share_agent_sessions", 1),
                 ("share_screenshots", {})]
        removed = [{**DEFAULTS, "break_reminder_minutes": 60}, {**DEFAULTS, "water_reminder_minutes": 90},
                   {**DEFAULTS, "ritual_report_time": "17:30"}]
        bodies = [missing, {**DEFAULTS, "extra": True}, [], None, "balanced", *removed,
                  *({**DEFAULTS, key: value} for key, value in wrong)]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.request(body), (400, {"error": "invalid_settings"}))
                self.assertEqual(self.state(), before)
        self.assertEqual(self.request(None, raw=b"{not json"), (400, {"error": "invalid_settings"}))
        self.assertEqual(self.state(), before)
        self.assertEqual(self.request(DEFAULTS, token=None)[0], 401)
        self.assertEqual(self.request(DEFAULTS, token="events-token")[0], 401)
        self.assertEqual(self.state(), before)

    def test_the_preset_reaches_every_copy(self):
        for name, same_cooldown, proactive in (("active", 300, True), ("quiet", 600, False), ("balanced", 600, True)):
            with self.subTest(name):
                self.put(interaction_preset=name)
                s = self.server
                self.assertEqual([s.interaction.name, s.gate.interaction.name, s.spatial.interaction.name,
                                  s.behavior.interaction.name], [name] * 4)
                self.assertEqual(s.diag_state()["interaction"]["name"], name)
                self.assertEqual((s.gate.same_cooldown, s.gate.enabled), (same_cooldown, proactive))
                self.assertEqual(s.facing_decisions.interval, 30)
        # Break and water keep their own minutes as the cooldown, whatever the preset's.
        self.put(interaction_preset="active")
        self.server.gate.commit("break", NOON)
        self.assertEqual((self.server.gate.check("break", NOON + datetime.timedelta(minutes=59)),
                          self.server.gate.check("break", NOON + datetime.timedelta(minutes=60))),
                         ("same_cooldown", None))

    def test_a_changed_preset_is_a_replay_input(self):
        events = []
        spatial = Spatial(lambda: {}, lambda *_: 1, lambda: 0, 1,
                          lane=MotionLane(lambda kind, trace_id, **fields: events.append((kind, fields["attrs"]))))
        spatial.begin()
        spatial.set_interaction("quiet")
        spatial.set_interaction("quiet")
        self.assertEqual([attrs for kind, attrs in events if kind == "interaction.preset"], [{"preset": "quiet"}])
        self.assertEqual(spatial.interaction.name, "quiet")

    def test_proactive_speech_off_and_on(self):
        gate = self.server.gate
        self.assertIsNone(gate.check("comment", NOON))
        self.put(proactive_speech=False)
        self.assertEqual((gate.enabled, gate.check("comment", NOON)), (False, "disabled"))
        self.put(proactive_speech=True, interaction_preset="quiet")  # the quiet preset holds proactive speech too
        self.assertEqual(gate.check("comment", NOON), "disabled")
        self.put(proactive_speech=True)
        self.assertEqual((gate.enabled, gate.check("comment", NOON)), (True, None))

    def test_mute(self):
        self.put(mute=True)
        self.assertTrue(self.server.muted)
        self.assertTrue(self.server.diag_state()["mouth_voice"]["muted"])
        self.put(mute=False)
        self.assertFalse(self.server.muted)
        self.assertFalse(self.server.diag_state()["mouth_voice"]["muted"])

    def test_redact(self):
        self.assertNotIn("a@b.example", self.server.egress.observed("mail a@b.example"))
        self.put(redact_sensitive=False)
        self.assertEqual(self.server.egress.observed("mail a@b.example"), "mail a@b.example")
        self.put(redact_sensitive=True)
        self.assertNotIn("a@b.example", self.server.egress.observed("mail a@b.example"))

    def test_each_sharing_switch_with_its_plugin(self):
        for key, kind in SWITCHES.items():
            with self.subTest(key):
                self.assertFalse(self.server.consent.snapshot()[0][kind])
                self.put(**{key: True})
                self.assertEqual({k for k, on in self.server.consent.snapshot()[0].items() if on}, {kind})
                self.put(**{key: False})
                self.assertFalse(any(self.server.consent.snapshot()[0].values()))
        self.put(share_screenshots=True)
        vision = self.server.capture.vision
        self.assertIsInstance(vision, SemanticVision)
        self.assertIs(vision.service, self.server.character_agent.semantic)
        self.put(share_screenshots=True)
        self.assertIs(self.server.capture.vision, vision)
        self.put()
        self.assertIsNone(self.server.capture.vision)

    def test_a_switch_whose_plugin_is_off_stays_off(self):
        self.plugins(False)
        self.put(**dict.fromkeys(PLUGINS, True))
        self.assertFalse(any(self.server.consent.snapshot()[0].values()))
        self.server.capture = None  # neither screen awareness nor screen reading: no capture
        self.put(share_window_text=True, share_screenshots=True)
        self.assertFalse(any(self.server.consent.snapshot()[0].values()))

    def test_the_saved_config_still_narrows_a_switch_turned_on(self):
        config = self.tmp / "config.json"
        config.write_text(json.dumps({"share_page_text": False, "share_typed_text": True}), encoding="utf-8")
        self.server.privacy_config = str(config)
        self.put(share_page_text=True, share_typed_text=True)
        permissions = self.server.consent.snapshot()[0]
        self.assertEqual((permissions["page_text"], permissions["typed_text"]), (False, True))


if __name__ == "__main__":
    unittest.main()
