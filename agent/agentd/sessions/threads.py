"""The session summaries of a time merged per session into the things worked on, and the day's report material code
words from the episodes, without a model."""
import collections
import datetime

STATES = {"done": "done", "needs_you": "waiting for you", "blocked": "stuck", "ongoing": "still going"}


def summary_rows(summaries):
    """Session summaries (WorkLog.sessions_on()'s rows) as merge()'s rows: the title for the session, the outcome or
    else the first next step for progress, the last thing done for last, the summary id for the episode id."""
    return [{"key": s["session_key"], "session": s["title"], "start": s["start"], "end": s["end"], "yours": s["yours"],
             "agent": s["agent_events"], "away": s["away"], "status": s["status"],
             "progress": s["body"].get("outcome") or next((step["text"] for step in s["body"].get("next_steps", [])),
                                                          None),
             "last": next((item["text"] for item in reversed(s["body"].get("did", []))), None), "episode_id": s["id"]}
            for s in summaries]


def merge(rows):
    """summary_rows()'s rows per session key: {"key", "session": the latest row's name, with the head of the key
    when another key has that name, "yours", "agent": the rows' counts summed, "yours_time", "agent_time", "away_time":
    seconds of the spans with lines of yours, with agent work, with agent work while you were away, "status",
    "progress", "last": each of the latest row that has one, "away_last": the latest last of the spans you were away
    for, "first", "end", "ids": the ids of its episodes, "yours_in": those with lines of yours in it}, oldest first;
    most lines of yours first, then most agent work."""
    merged = {}
    for row in sorted(rows, key=lambda r: r["end"]):
        thread = merged.setdefault(row["key"], {
            "key": row["key"], "yours": 0, "agent": 0, "yours_time": 0, "agent_time": 0, "away_time": 0, "status": None,
            "progress": None, "last": None, "away_last": None, "first": row["start"], "end": row["end"], "ids": [],
            "yours_in": []})
        thread["session"] = row["session"]
        span = row["end"] - row["start"]
        thread["yours"] += row["yours"]
        thread["agent"] += row["agent"]
        thread["yours_time"] += span if row["yours"] else 0
        thread["agent_time"] += span if row["agent"] else 0
        thread["away_time"] += span if row["agent"] and row["away"] else 0
        thread["first"], thread["end"] = min(thread["first"], row["start"]), row["end"]
        for key in ("status", "progress", "last"):
            thread[key] = row[key] or thread[key]
        if row["away"]:
            thread["away_last"] = row["last"] or thread["away_last"]
        thread["ids"].append(row["episode_id"])
        if row["yours"]:
            thread["yours_in"].append(row["episode_id"])
    shared = collections.Counter(t["session"] for t in merged.values())
    for key, thread in merged.items():
        if shared[thread["session"]] > 1:
            thread["session"] = f"{thread['session']} ({key[:8]})"
    return sorted(merged.values(), key=lambda t: (-t["yours"], -t["agent"]))


def _local(ts):
    return datetime.datetime.fromtimestamp(ts)


ARC_MAX = 8  # spans of a day's arc


ARC_CHARS = 600  # characters of a day's arc


def day_arc(episodes):
    """A day's episodes (between()'s list) as "HH:MM–HH:MM title" spans joined by "; ", neighbours with one title merged;
    None for no episodes."""
    if not episodes:
        return None
    spans = []  # [start, end, title]
    for episode in episodes:
        if spans and spans[-1][2] == episode["title"]:
            spans[-1][1] = episode["end"]
        else:
            spans.append([episode["start"], episode["end"], episode["title"]])
    if len(spans) > ARC_MAX:
        spans = [spans[round(i * (len(spans) - 1) / (ARC_MAX - 1))] for i in range(ARC_MAX)]
    text = "; ".join(f"{_local(start):%H:%M}–{_local(end):%H:%M} {title}" for start, end, title in spans)
    return text[:ARC_CHARS]
