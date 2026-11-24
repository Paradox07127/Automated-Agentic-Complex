"""Each cut of server.CUTS at each moment of a two-clause line, as agentd sees it: the model stream, the
turn_generation, the speech_cancelled events, and the line's history row and window turn."""
import dataclasses
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from test_server import KernelLines, ScriptedMouth  # noqa: E402
from personal.history import History  # noqa: E402
from personal.memory import Memory  # noqa: E402
from infra.store import open_store  # noqa: E402
from test_history_server import REPLY  # noqa: E402
from test_playback_server import HALF, PlaybackCase  # noqa: E402
from test_turn import wait_for  # noqa: E402

FIRST, SECOND = "第一句话说完了，", "第二句话也说完了。"
TEXT = FIRST + SECOND
CHUNKS = ["第一", "句话", "说完了，", SECOND]  # T2 holds after the first delta, before the first clause ends
# relay.heard: an interrupted clause keeps the share of its characters its played samples are of its total
# (FakeTTS sends 2 * HALF), rounded.
HEARD = FIRST[:round(len(FIRST) * HALF / (2 * HALF))]
USER, PROMPT, NEW, PROBE = "你好", "（主动搭话）", "新的话", "下一句"
PROACTIVE = "p1"  # line_id of the proactive line hide cuts
MOMENTS = ("T1", "T2", "T3", "T4", "T5")


class HeldMouth(ScriptedMouth):
    """A ScriptedMouth whose first stream plays CHUNKS and, with hold "T1", waits before its first delta, with
    hold "T2" right after it, until cancel_active aborts it or the test sets release. Later streams play the
    fake's own chunks."""

    def __init__(self, fake, hold, **kwargs):
        super().__init__(fake, **kwargs)
        self.fake, self.hold, self.first = fake, hold, True
        self.held, self.release = threading.Event(), threading.Event()
        self.aborts, self.open, self.aborted = 0, False, False

    def stream(self, text, context):
        if not self.first:
            yield from super().stream(text, context)
            return
        self.first = False
        if self.hold == "T1" and not self.wait():
            return
        chunks, self.fake.chunks = self.fake.chunks, CHUNKS
        inner = super().stream(text, context)
        try:
            for n, delta in enumerate(inner):
                if n == 0:
                    self.fake.chunks = chunks  # the fake built this response before its first delta went out
                yield delta
                if n == 0 and self.hold == "T2" and not self.wait():
                    return
        finally:
            inner.close()

    def wait(self):
        """Hold here; False when cancel_active aborted the stream."""
        self.open = True
        self.held.set()
        self.release.wait(5)
        self.open = False
        return not self.aborted

    def cancel_active(self):
        if self.open:
            self.aborts += 1
            self.aborted = True
            self.release.set()


@dataclasses.dataclass(frozen=True)
class Cell:
    """aborts: cancel_active calls on the held stream; step: how far turn_generation moved; events: per
    speech_cancelled, how far its turn_generation is past the one before the cut; null_id: each event's speech_id
    is null (False: not checked); state, reply: the line's history row (reply None: not checked); kept: the line's
    assistant turn in the next request's window, None for no turn; voiced: TTS requests of the line before the next
    one (None: not checked)."""
    aborts: int
    step: int
    events: tuple
    null_id: bool
    state: str
    reply: str = None
    kept: str = None
    voiced: tuple = None


ENDS_LINE = {  # A: barge_in, stop, switch, context_cleared
    "T1": Cell(1, 1, (1,), True, "cancelled", ""),
    "T2": Cell(1, 1, (1,), True, "cancelled"),
    "T3": Cell(0, 1, (1,), False, "cancelled", TEXT),
    "T4": Cell(0, 1, (1,), False, "interrupted", HEARD, HEARD),
    "T5": Cell(0, 1, (1,), False, "interrupted", FIRST, FIRST),
}
SUPERSEDE = {**ENDS_LINE,  # B: no event while the old line voiced nothing
             "T1": dataclasses.replace(ENDS_LINE["T1"], events=(), null_id=False),
             "T2": dataclasses.replace(ENDS_LINE["T2"], events=(), null_id=False)}
MEMORY = {moment: dataclasses.replace(cell, state="cancelled", reply=None, kept=None)  # C
          for moment, cell in ENDS_LINE.items()}
SPEECH_ONLY = {  # D: mute, hide
    "T1": Cell(0, 0, (), False, "completed", TEXT, TEXT, ()),
    "T2": Cell(0, 0, (), False, "completed", TEXT, TEXT, ()),
    "T3": Cell(0, 0, (0,), False, "cancelled"),
    "T4": Cell(0, 0, (0,), False, "interrupted", HEARD, HEARD),
    "T5": Cell(0, 0, (0,), False, "interrupted", FIRST, FIRST),
}
GROUPS = {"barge_in": ENDS_LINE, "stop": ENDS_LINE, "supersede": SUPERSEDE, "switch": ENDS_LINE,
          "memory_changed": MEMORY, "context_cleared": ENDS_LINE, "mute": SPEECH_ONLY, "hide": SPEECH_ONLY}
EXPECTED = {(entry, moment): group[moment] for entry, group in GROUPS.items() for moment in MOMENTS}

# entry -> (method, path, body, status); memory_changed's path takes the fact_id
TRIGGERS = {"barge_in": ("POST", "/turn/cancel", {"reason": "barge_in"}, 202),
            "stop": ("POST", "/say", {"text": "停下"}, 200),
            "supersede": ("POST", "/say", {"text": NEW}, 202),
            "switch": ("POST", "/character", {"id": "birch"}, 200),
            "memory_changed": ("PATCH", "/memory/facts/{}", {"expected_version": 1, "text": "阿岩", "cascade": []}, 200),
            "context_cleared": ("DELETE", "/attention", None, 200),
            "mute": ("POST", "/say", {"text": "静音"}, 200),
            "hide": ("PUT", "/avatar/visibility", {"visible": False, "reason": "user"}, 200)}


class CancelMatrixTest(PlaybackCase):
    def row(self, line_id):
        """line_id's history row, None before it is written."""
        return next((r for r in History(open_store(self.db)).export() if r["turn_id"] == line_id), None)

    def settled(self, line_id):
        self.assertTrue(wait_for(lambda: self.row(line_id) is not None and not self.server._live_lines))

    def speech_cancelled(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "speech_cancelled"]

    def cut_line(self, entry, moment):
        """The line entry cuts, brought to moment; its line_id. A held line waits in its stream."""
        hold = moment if moment in ("T1", "T2") else None
        self.server.mouth = HeldMouth(self.fake, hold, memory=self.server.memory)
        if entry == "hide":
            self.server.character_agent = KernelLines(self.server)  # a proactive line runs on the character agent
            self.server.start_line(PROACTIVE, PROMPT)
            line_id = PROACTIVE
        else:
            status, body = self.request("POST", "/say", {"text": USER})
            self.assertEqual(status, 202)
            line_id = body["line_id"]
        if hold:
            self.assertTrue(self.server.mouth.held.wait(5))
            return line_id
        self.settled(line_id)
        self.collect(self.relay, 2)
        self.assertEqual([b["text"] for _, b in self.tts.bodies], [FIRST, SECOND])
        self.first = self.tts.bodies[0][1]["speech_id"]
        if moment in ("T4", "T5"):
            self.assertEqual(self.receipt(self.first, "started")[1]["applied"], True)
        if moment == "T5":
            self.assertEqual(self.receipt(self.first, "ended", 2 * HALF)[1]["applied"], True)
        return line_id

    def trigger(self, entry):
        """The cut; for supersede, the new line's line_id."""
        method, path, body, status = TRIGGERS[entry]
        replied = self.request(method, path.format(getattr(self, "fact_id", "")), body)
        self.assertEqual(replied[0], status, replied)
        return replied[1]["line_id"] if entry == "supersede" else None

    def end_speech(self, line_id):
        """Each clause of line_id plays to its end, so a later line cuts nothing of it."""
        self.assertTrue(wait_for(lambda: self.server._voiced is not None and self.server._voiced[0] == line_id))
        utterance = self.server._voiced[1]
        self.assertTrue(wait_for(lambda: all(c["state"] is not None for c in self.relay.utterance(utterance))))
        for clause in self.relay.utterance(utterance):
            self.receipt(clause["speech_id"], "started")
            self.receipt(clause["speech_id"], "ended", 2 * HALF)

    def run_cell(self, entry, moment):
        cell = EXPECTED[(entry, moment)]
        if entry == "memory_changed":
            self.server.memory = Memory(open_store(self.db))
            # A resident fact goes into every turn, so the line's request uses it.
            self.fact_id = self.server.memory.add("阿砚", "confirmed_by_user", kind="name")
        if entry == "context_cleared":  # the line's context then uses the activity
            self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                                   Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")))
            self.addCleanup(self.server.attention.close)
        line_id = self.cut_line(entry, moment)
        generation, mouth = self.server.turn_generation, self.server.mouth
        new_line = self.trigger(entry)
        mouth.release.set()  # a held line the cut did not abort runs on
        if moment == "T4":
            self.receipt(self.first, "interrupted", HALF, reason="client_cancel")
        self.settled(line_id)
        if new_line is not None:
            self.settled(new_line)
            self.end_speech(new_line)
        step, events = self.server.turn_generation - generation, self.speech_cancelled()
        voiced = tuple(b["text"] for _, b in self.tts.bodies if b["turn_id"] == line_id)
        self.line(PROBE)
        row = self.row(line_id)
        actual = {"aborts": mouth.aborts, "step": step,
                  "events": tuple(e["turn_generation"] - generation for e in events),
                  "state": row["state"], "window": self.past()}
        expected = {"aborts": cell.aborts, "step": cell.step, "events": cell.events, "state": cell.state,
                    # A switch moves to the new character's own topic: the cut line stays in the old one's.
                    "window": ([PROMPT if entry == "hide" else USER, cell.kept] if cell.kept and entry != "switch" else [])
                    + ([NEW, "".join(REPLY)] if entry == "supersede" else []) + [PROBE]}
        if cell.null_id:
            expected["speech_ids"], actual["speech_ids"] = [None] * len(events), [e["speech_id"] for e in events]
        if cell.reply is not None:
            expected["reply"], actual["reply"] = cell.reply, row["reply"]
        if cell.voiced is not None:
            expected["voiced"], actual["voiced"] = cell.voiced, voiced
        self.assertEqual(actual, expected, f"{entry} at {moment}")

    def test_hide_spares_a_user_line_at_T4(self):
        line_id = self.cut_line("barge_in", "T4")
        generation = self.server.turn_generation
        self.trigger("hide")
        self.assertTrue(self.relay.busy())
        self.assertEqual((self.server.mouth.aborts, self.server.turn_generation, self.speech_cancelled()),
                         (0, generation, []))
        self.line(PROBE)
        row = self.row(line_id)
        self.assertEqual((row["state"], row["reply"], self.past()), ("completed", TEXT, [USER, TEXT, PROBE]))


class HeldWindowTest(PlaybackCase):
    """A receipt that keeps a line cut while it streamed, arriving while another line streams, changes the window
    once that line is done with it."""
    STREAMED = "第一句话说完了。"
    row = CancelMatrixTest.row

    def cut_streaming(self):
        """A line cut while it streamed, its first clause still playing; that clause's speech_id."""
        self.server.mouth = HeldMouth(self.fake, "T2")
        self.server.mouth.first = False  # this line streams the fake's own chunks, unheld
        self.fake.chunks, self.fake.delay = [self.STREAMED] + ["二"] * 20, 0.1
        self.assertEqual(self.request("POST", "/say", {"text": USER})[0], 202)
        self.collect(self.relay, 1)
        first = self.tts.bodies[0][1]["speech_id"]
        self.receipt(first, "started")
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.fake.chunks, self.fake.delay = REPLY, 0.0
        return first

    def held_receipt(self):
        """cut_streaming, then a second line held in its stream while the first clause's end receipt arrives."""
        first = self.cut_streaming()
        self.server.mouth.first = True
        self.assertEqual(self.request("POST", "/say", {"text": NEW})[0], 202)
        self.assertTrue(self.server.mouth.held.wait(5))
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)

    def window(self):
        return [[m["content"] for m in turn] for turn in self.server.mouth.history]

    def test_the_kept_line_stays_when_the_held_line_is_cut(self):
        self.held_receipt()
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.window(), [[USER, self.STREAMED]])

    def test_the_kept_line_goes_before_the_held_line_that_finishes(self):
        self.held_receipt()
        self.server.mouth.release.set()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.window(), [[USER, self.STREAMED], [NEW, TEXT]])

    def test_a_longer_heard_part_reaches_a_kept_line_still_queued(self):
        self.held_receipt()
        [row] = self.rows()
        longer = self.STREAMED + "二"
        self.server._settle(row["turn_id"], longer)
        self.server.mouth.release.set()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual((self.row(row["turn_id"])["reply"], self.window()), (longer, [[USER, longer], [NEW, TEXT]]))


def _cell_test(entry, moment):
    return lambda self: self.run_cell(entry, moment)


for _entry, _moment in EXPECTED:
    setattr(CancelMatrixTest, f"test_{_entry}_at_{_moment}", _cell_test(_entry, _moment))


if __name__ == "__main__":
    unittest.main()
