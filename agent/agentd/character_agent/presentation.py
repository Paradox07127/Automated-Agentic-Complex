"""Feed a verified SDK reply through existing playback/history delivery, without another model."""
import threading
from types import SimpleNamespace
from character_agent.harness.transport import HarnessError


class PreparedReply:
    history_text = None  # what the mouth's history keeps of the turn's text, when not the text stream gets
    needs_context = False  # text is already fixed; turns.py does not need to assemble a fresh prompt context

    def __init__(self, mouth, text, model, usage=None, facts=None, error=None, *, final_item_id=None, remember=True):
        """remember False: the line is delivered but its turn stays out of the mouth's history."""
        self.history = mouth.history
        self.remember = remember
        self.max_turns = mouth.max_turns
        self.model = model
        self.usage = None
        self.result_usage = SimpleNamespace(**(usage or {}))
        self.text, self.error = text, error
        self.final_item_id = final_item_id
        self.facts = facts or {"trusted": [], "low_trust": []}
        self.used_facts = [(f["fact_id"], f["version"]) for f in self.facts["trusted"] + self.facts["low_trust"]]
        self.dispatch_allowed = lambda: True

    def pick_facts(self, *_args, **_kwargs):
        return self.facts

    def pick_lore(self, *_args):
        return []

    def stream(self, text, _context):
        if not self.dispatch_allowed():
            return
        if self.error:
            raise HarnessError(self.error)
        yield self.text
        if self.dispatch_allowed():
            self.usage = self.result_usage
            if self.remember:
                self.history.append([{"role": "user", "content": text if self.history_text is None else self.history_text},
                                     {"role": "assistant", "content": self.text}])
                del self.history[:-self.max_turns]


def _rest(said, final):
    """What final adds to the text already said: its tail, or a prefix put after it; all of final when it has neither."""
    if final.startswith(said):
        return final[len(said):]
    if said and final.endswith(said):
        return "\n\n" + final[:-len(said)].strip()
    return "\n\n" + final if final.strip() else ""


class StreamedReply(PreparedReply):
    """A PreparedReply whose run is still writing it. The run calls delta() with the text of its top-level
    commentary (the words before a tool call) and final answer, and ended() as it returns; the thread running
    prepare calls prepared(). stream() yields each delta as it comes, then only what the final text adds to
    the final answer's deltas."""

    history = property(lambda self: self._mouth.history)  # read only once an answer streams
    max_turns = property(lambda self: self._mouth.max_turns)

    def __init__(self, mouth):
        self._mouth, self.model, self.usage = mouth, None, None
        self.remember = True  # prepare's reply sets it
        self._take("", None, None, None, None)
        self.dispatch_allowed = lambda: True
        self.settled = lambda: None  # run in stream() once the final text, facts and final_item_id are known
        self.memory_changed = False  # the run changed memory: prepare needs the mouth lock its line holds
        self.reply = self.failure = None  # what prepare returned or raised
        self._parts = []
        self._ended = self._done = False
        self._cv = threading.Condition()

    def delta(self, text, item_id=None, final=True):
        with self._cv:
            self._parts.append((text, item_id, final))
            self._cv.notify_all()

    def ended(self, reply, memory_changed):
        with self._cv:
            if reply is not None:
                self._take(reply.text, reply.error, reply.usage, reply.facts, reply.final_item_id)
            self._ended, self.memory_changed = reply is not None, memory_changed
            self._cv.notify_all()

    def prepared(self, reply=None, failure=None):
        with self._cv:
            if reply is not None and self._parts:  # with no delta yet, the line gets reply itself as before
                if not self._ended:
                    self._take(reply.text, reply.error, vars(reply.result_usage), reply.facts, reply.final_item_id)
                self.model, self.remember = reply.model, reply.remember
            self.reply, self.failure, self._done = reply, failure, True
            self._cv.notify_all()

    def begun(self):
        """Waits for the first delta or prepare's end; True when there is a delta."""
        with self._cv:
            self._cv.wait_for(lambda: self._parts or self._done)
            return bool(self._parts)

    def _take(self, text, error, usage, facts, final_item_id):
        self.text, self.error, self.final_item_id = text, error, final_item_id
        self.result_usage = SimpleNamespace(**(usage or {}))
        self.facts = facts or {"trusted": [], "low_trust": []}
        self.used_facts = [(f["fact_id"], f["version"]) for f in self.facts["trusted"] + self.facts["low_trust"]]

    def stream(self, text, _context):
        said, final_said, final_parts, taken, item = [], [], [], 0, None
        while True:
            with self._cv:
                ready = lambda: len(self._parts) > taken or self._done or self._ended and self.memory_changed
                if not self._cv.wait_for(ready, 0.05):
                    parts, last = [], False
                else:
                    parts, last = self._parts[taken:], self._done or self._ended and self.memory_changed
            if not self.dispatch_allowed():
                return
            taken += len(parts)
            for part, part_item, final in parts:
                if not part:
                    continue
                if said and part_item != item:
                    # one blank line between items, counting the newlines either side already has
                    told = "".join(said)
                    gap = "\n" * max(0, 2 - (len(told) - len(told.rstrip("\n"))) - (len(part) - len(part.lstrip("\n"))))
                    if gap:
                        said.append(gap)
                        if final and final_said:  # a final text may join its items with the same gap
                            final_said.append(gap)
                        yield gap
                item = part_item
                said.append(part)
                if final:
                    final_said.append(part)
                    final_parts.append(part)
                yield part
            if last and not parts:
                break
        if self.failure is not None:
            raise self.failure
        if self.error:
            raise HarnessError(self.error)
        self.settled()
        told, gapless = "".join(final_said), "".join(final_parts)
        if not self.text.startswith(told) and self.text.startswith(gapless):
            told = gapless  # the Claude and ACP runners and pi join the final items without the gap
        rest = _rest(told, self.text)
        if rest and said and not final_said and not rest.startswith("\n\n"):
            rest = "\n\n" + rest  # the final answer is a new paragraph after the commentary
        if rest:
            said.append(rest)
            yield rest
        if self.dispatch_allowed():
            self.usage = self.result_usage
            if self.remember:
                self.history.append([{"role": "user", "content": text if self.history_text is None else self.history_text},
                                     {"role": "assistant", "content": "".join(said)}])
                del self.history[:-self.max_turns]
