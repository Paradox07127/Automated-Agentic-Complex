"""History keeps only the <event> element of a cue line; the user's own words are kept whole."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.events import cue, recorded  # noqa: E402
from character_agent.presentation import PreparedReply  # noqa: E402
import test_playback_server  # noqa: E402
import test_server  # noqa: E402
from test_history_server import HistoryServerCase  # noqa: E402
from test_turn import wait_for  # noqa: E402

CUE = cue("tap", "管理员 touched your head.", "React in a line.", region="head")


class PreparedLines(test_server.KernelLines):
    """A character agent whose reply is a PreparedReply on the server's mouth; streamed: its run writes a delta first,
    so the line streams a StreamedReply."""
    streamed = False

    def __init__(self, server):
        super().__init__(server)
        self.texts = []

    def prepare(self, line_id, text, cancel, generation, source, trace, wait=None, refused=None, **options):
        self.texts.append(text)
        if self.streamed:
            cancel.answer.delta("好呀。")
        return PreparedReply(self.server.mouth, "好呀。", "test")


class EventHistoryTest(HistoryServerCase):
    def setUp(self):
        super().setUp()
        self.server.character_agent = self.agent = PreparedLines(self.server)

    def settled(self, line_id):
        self.assertTrue(wait_for(lambda: any(r["turn_id"] == line_id for r in self.rows())))
        return next(r for r in self.rows() if r["turn_id"] == line_id)

    def test_a_cue_line_keeps_only_its_event(self):
        for source in ("tap", "ritual", "proactive"):
            with self.subTest(source=source):
                self.server.start_line(f"l-{source}", CUE, source=source)
                self.assertEqual(self.settled(f"l-{source}")["user_text"], recorded(CUE))
                self.assertTrue(wait_for(lambda: self.server.mouth.history
                                         and self.server.mouth.history[-1][1]["content"] == "好呀。"))
                self.assertEqual(self.server.mouth.history[-1][0]["content"], recorded(CUE))
                self.assertEqual(self.agent.texts[-1], CUE)  # the model still gets the whole cue
                self.server.mouth.history.clear()

    def test_a_streamed_cue_line_keeps_only_its_event(self):
        self.agent.streamed = True
        self.server.start_line("l-tap", CUE, source="tap")
        self.assertEqual(self.settled("l-tap")["user_text"], recorded(CUE))
        self.assertTrue(wait_for(lambda: self.server.mouth.history))
        self.assertEqual(self.server.mouth.history[-1][0]["content"], recorded(CUE))

    def test_typed_text_like_a_cue_is_kept_whole(self):
        self.line(CUE, source="text")
        self.assertEqual([r["user_text"] for r in self.rows()], [CUE])
        self.assertTrue(wait_for(lambda: self.server.mouth.history))
        self.assertEqual(self.server.mouth.history[-1][0]["content"], CUE)


class CutCueLineTest(test_playback_server.PlaybackCase):
    FIRST = "第一句话说完了。"

    def test_a_cue_line_cut_while_it_plays_keeps_only_its_event(self):
        self.server.character_agent = test_server.KernelLines(self.server)
        self.fake.chunks, self.fake.delay = [self.FIRST] + ["二"] * 20, 0.1
        self.server.start_line("l-tap", CUE, source="tap")
        self.collect(self.relay, 1)
        first = self.tts.bodies[0][1]["speech_id"]
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * test_playback_server.HALF)
        self.assertTrue(self.server._live_lines)  # still streaming
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertTrue(wait_for(lambda: self.server.mouth.history))
        self.assertEqual([m["content"] for m in self.server.mouth.history[-1]], [recorded(CUE), self.FIRST])


if __name__ == "__main__":
    unittest.main()
