"""Where the time of a voice turn goes, from the release of the talk key to her first audio playing: the median, p90,
max (ms) and sample count of each segment over the latest voice turns in agentd's trace store (C6 T1). Read-only.

usage: voice_timing.py --state-dir DIR [--last N]"""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import sqlite3
import statistics
import sys
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.paths import agentd_db  # noqa: E402

LOCAL = ("agentd", "tts")  # producers whose t_mono_ms is agentd's own monotonic clock
NO_DATA = "没有数据"
# number, what it spans, the marks it runs between
SEGMENTS = (
    ("1", "松键→agentd收到", "voice_timing.released_ms→input.received"),
    ("2", "收到→发出模型请求", "input.received→model.started"),
    ("3", "发出请求→模型首字", "model.started→model.first_token"),
    ("4", "首字→第一个分句送合成", "model.first_token→speech.requested"),
    ("5", "送合成→第一包音频", "speech.requested→speech.first_audio"),
    ("6", "第一包音频→开始播放", "speech.first_audio→playback.started"),
)


def _mark(event):
    """(wall ms, (producer_epoch, mono ms) on agentd's monotonic clock or None) of a stored event."""
    wall = round(datetime.fromisoformat(event["t_wall"]).timestamp() * 1000)
    local = event["producer"] in LOCAL
    return wall, (event["producer_epoch"], event["t_mono_ms"]) if local else None


def _gap(start, end):
    """ms from start to end: on agentd's monotonic clock when both are on it, else by the wall."""
    if start[1] is not None and end[1] is not None and start[1][0] == end[1][0]:
        return end[1][1] - start[1][1]
    return end[0] - start[0]


def _marks(events):
    """The seven marks of one turn's events in store order, None for each one it did not trace."""
    first = lambda test: next((e for e in events if test(e)), None)  # noqa: E731
    received = first(lambda e: e["kind"] == "input.received")
    started = first(lambda e: e["kind"] == "model.started" and e["attrs"]["call"] == "character_agent")
    token = started and first(lambda e: e["kind"] == "model.first_token" and e["span_id"] == started["span_id"])
    requested = first(lambda e: e["kind"] == "speech.requested")
    speech_id = requested and requested["attrs"]["speech_id"]
    audio = first(lambda e: e["kind"] == "speech.first_audio" and e["attrs"]["speech_id"] == speech_id)
    played = first(lambda e: e["kind"] == "playback.started" and e["attrs"]["speech_id"] == speech_id)
    released = (received or {}).get("attrs", {}).get("voice_timing", {}).get("released_ms")
    return [None if released is None else (released, None)] + \
        [None if e is None else _mark(e) for e in (received, started, token, requested, audio, played)]


def measure(db, last):
    """(turns read, the ms samples of each segment) over the latest `last` voice turns."""
    traces = [row[0] for row in db.execute(
        "SELECT trace_id FROM trace_events WHERE kind='input.received' AND json_extract(event,'$.attrs.source')='voice'"
        " GROUP BY trace_id ORDER BY MAX(id) DESC LIMIT ?", (last,))]
    samples = [[] for _ in SEGMENTS]
    for trace_id in traces:
        events = [json.loads(row[0]) for row in
                  db.execute("SELECT event FROM trace_events WHERE trace_id = ? ORDER BY id", (trace_id,))]
        marks = _marks(events)
        for n, (start, end) in enumerate(zip(marks, marks[1:])):
            if start is not None and end is not None:
                samples[n].append(_gap(start, end))
    return len(traces), samples


def _width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _pad(text, width):
    return text + " " * (width - _width(text))


def render(turns, last, samples, db_path):
    head = ["段", "从→到", "事件", "样本", "中位数", "p90", "最大"]
    rows = []
    for (number, span, marks), found in zip(SEGMENTS, samples):
        if not found:
            rows.append([number, span, marks, NO_DATA])
            continue
        ordered = sorted(found)
        rows.append([number, span, marks, str(len(found)), str(round(statistics.median(ordered))),
                     str(ordered[math.ceil(0.9 * len(ordered)) - 1]), str(ordered[-1])])
    widths = [max(_width(r[i]) for r in [head, *rows] if i < len(r)) for i in range(len(head))]
    lines = [f"语音对话分段耗时（毫秒）：只统计语音轮（input.received 的 source=voice），最近 {turns} 轮（--last {last}）",
             f"来自 {db_path}（只读）。第 1 段是外壳的 Unix 毫秒对 agentd 的墙钟，第 6 段对渲染器的墙钟；"
             "两端都是 agentd 的事件时用它的单调钟。", ""]
    for r in [head, *rows]:
        lines.append("  ".join(_pad(cell, widths[i]) for i, cell in enumerate(r)).rstrip())
    return "\n".join(lines)


def report(state_dir, last=50):
    """The table of the latest `last` voice turns in state_dir's agentd.sqlite, opened read-only."""
    path = agentd_db(state_dir).resolve()
    db = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    try:
        turns, samples = measure(db, last)
    finally:
        db.close()
    return render(turns, last, samples, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--state-dir", required=True, help="agentd's state directory (holds agentd.sqlite)")
    parser.add_argument("--last", type=int, default=50, help="how many of the latest voice turns (default 50)")
    args = parser.parse_args()
    if args.last < 1:
        parser.error("--last must be at least 1")
    if not agentd_db(args.state_dir).is_file():
        parser.error(f"no {agentd_db(args.state_dir)}")
    # A Windows pipe or file would get the ANSI code page, which cannot encode the Chinese table.
    sys.stdout.reconfigure(encoding="utf-8")
    print(report(args.state_dir, args.last))


if __name__ == "__main__":
    main()
