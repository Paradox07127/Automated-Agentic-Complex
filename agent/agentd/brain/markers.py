"""Streaming parser for inline [intent:x] / [point:...] / [motion:text|seconds] markers; only whitelisted values pass (C3).
A Markdown link [label](target) passes as its label."""
import re

# C1 intent enum.
INTENTS = {"none", "idle", "listen", "think", "greet", "acknowledge", "explain",
           "offer", "uncertain", "reassure", "celebrate", "apologize"}
# Longest bracket run treated as a possible marker; longer ones are plain text.
MAX_MARKER = 64
MAX_MOTION_MARKER = 200  # a [motion:...] marker carries an English description
MAX_LINK_TARGET = 300  # longest "(target)" held back as a Markdown link's; a longer one stays text
_MARKER = re.compile(r"^([a-z_]+):(.*)$")
_XY = re.compile(r"^(-?\d+),(-?\d+)$")
_WINDOW = re.compile(r"^[A-Za-z0-9_-]+$")
_MOTION = re.compile(r"^([ -~]{3,160})\|(\d+(?:\.\d+)?)$")  # printable ASCII text, then seconds
MOTION_SECONDS = (1, 6)


class MarkerStream:
    """feed(chunk) / close() -> (text, intents, points); markers are removed from the text.
    motions: {prompt, seconds} of each valid motion marker fed so far, in order."""

    def __init__(self):
        self._pending = ""
        self.motions = []

    def feed(self, chunk):
        data, self._pending = self._pending + chunk, ""
        text, intents, points = [], [], []
        while data:
            start = data.find("[")
            if start < 0:
                text.append(data)
                break
            text.append(data[:start])
            data = data[start:]
            end = data.find("]")
            inner = data[1:end] if end > 0 else data[1:]
            limit = MAX_MOTION_MARKER if data.startswith("[motion:") else MAX_MARKER
            if "[" in inner or (end < 0 and len(data) > limit) or end > limit:
                text.append("[")
                data = data[1:]
                continue
            if end < 0:
                self._pending = data
                break
            match = _MARKER.match(inner)
            if match is None:
                after = data[end + 1:]
                close = after.find(")") if after.startswith("(") else -1
                if not after or after.startswith("(") and close < 0 and len(after) <= MAX_LINK_TARGET \
                        and not any(c.isspace() for c in after):
                    self._pending = data  # a link's "(target)" may still come
                    break
                if close > 1 and not any(c.isspace() for c in after[1:close]):
                    text.append(inner)  # a Markdown link: its label only, as it is shown and voiced
                    data = after[close + 1:]
                    continue
                text.append(data[:end + 1])
            else:
                self._marker(match.group(1), match.group(2), intents, points, self.motions)
            data = data[end + 1:]
        return "".join(text), intents, points

    def close(self):
        text, self._pending = self._pending, ""
        return text, [], []

    @staticmethod
    def _marker(name, value, intents, points, motions):
        if name == "intent" and value in INTENTS:
            intents.append(value)
        elif name == "motion":
            motion = _MOTION.match(value)
            if motion and MOTION_SECONDS[0] <= float(motion.group(2)) <= MOTION_SECONDS[1]:
                motions.append({"prompt": motion.group(1), "seconds": float(motion.group(2))})
        elif name == "point":
            xy = _XY.match(value)
            if xy:
                points.append({"x": int(xy.group(1)), "y": int(xy.group(2))})
            elif _WINDOW.match(value):
                points.append({"window": value})
