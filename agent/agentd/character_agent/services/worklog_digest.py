"""Live hook frames of the coding agents cut into L1 segments and pressed into a bounded model input; deterministic,
no model call. A frame is a dict as ObservationService.get gives it: id, at, requires, metadata (app is the agent,
doc the cwd, label the session id, role the hook kind, subrole the tool) and, for digest, text (the hook's JSON)."""
import datetime
import json
import re

from sessions.events import command_text, tool_category
from sessions.session_digest import COUNT, TEST_CMD

IDLE = 15 * 60  # a segment closes after this long without a frame of its session
LONG = 90 * 60  # and at this length, as a phase the next segment continues from
SMALL_SPAN, SMALL_FRAMES = 3 * 60, 10  # a shorter segment with fewer frames and no prompt joins the next one
WORKER_SPAN = 15 * 60  # a finished session shorter than this with one prompt is a worker
WORKER = re.compile(r"^(?P<repo>.+)-\d{8}-\d{6}-[0-9a-f]{3,}$")
WORKTREE = re.compile(r"/\.claude/worktrees/.*$")
AGENT_WORKTREE = re.compile(r"/\.claude/worktrees/agent-[0-9a-f]+(?:/|$)")
LIMIT = 24000  # characters of digest's input as JSON
PROMPT_HEAD, PROMPT_TAIL = 1500, 500
AGENT_TEXT = 1500
COMMAND_TEXT = 160
LINE_TEXT = 300
PREVIOUS_TEXT = 200
TOOLS_KEPT = 20
# the first prompt stays besides
LATEST = {"user": 6, "orchestrator": 6, "agent": 6, "check": 20, "edit": 20, "cmd": 20, "fail": 20}
# oldest first within a tag, the first prompt last
DROP_ORDER = ("cmd", "edit", "fail", "check", "agent", "orchestrator", "user")
PROMPT_TAGS = ("user", "orchestrator")  # a worker batch's prompts are the orchestrating agent's tasks
EXIT = re.compile(r"(?:Error: )?Exit code:? (\d+)")
PATCH_FILE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", re.M)


def _dump(value):
    return json.dumps(value, ensure_ascii=False)


def _day(at):
    return datetime.date.fromtimestamp(at)


def _role(frame):
    return frame["metadata"].get("role")


def _repo(cwd):
    """cwd without a Claude worktree or worker suffix."""
    path = WORKTREE.sub("", cwd.rstrip("/"))
    match = WORKER.match(path)
    return match["repo"] if match else path


def project(cwd):
    """The repository name of cwd, or None."""
    return (_repo(cwd).rsplit("/", 1)[-1] or None) if cwd else None


def _small(frames):
    return (frames[-1]["at"] - frames[0]["at"] < SMALL_SPAN and len(frames) < SMALL_FRAMES
            and not any(_role(f) == "prompt_submit" for f in frames))


def _pieces(rows, now):
    """One session's frames cut at idle gaps, its end, local midnight and LONG; a small piece joins the next one
    unless midnight cut it, and goes when none follows."""
    pieces, piece = [], []
    for frame in rows:
        if piece:
            first, last = piece[0], piece[-1]
            cut = ("end" if _role(last) == "session_end" else "idle" if frame["at"] - last["at"] >= IDLE
                   else "midnight" if _day(frame["at"]) != _day(first["at"])
                   else "length" if frame["at"] - first["at"] >= LONG else None)
            if cut:
                pieces.append({"frames": piece, "closed": True, "cut": cut})
                piece = []
        piece.append(frame)
    cut = "end" if _role(piece[-1]) == "session_end" else "idle" if now - piece[-1]["at"] >= IDLE else None
    pieces.append({"frames": piece, "closed": cut is not None, "cut": cut})
    kept, carried = [], []
    for index, piece in enumerate(pieces):
        frames = carried + piece["frames"]
        carried = []
        if piece["closed"] and _small(frames):
            if piece["cut"] != "midnight" and index + 1 < len(pieces):
                carried = frames
            continue
        kept.append({**piece, "frames": frames})
    return kept


def _away(start, end, runs):
    afk = sum(max(0, min(b, end) - max(a, start)) for a, b, status in runs if status == "afk")
    return end > start and afk * 2 > end - start


def _segment(kind, agent, key, cwd, frames, closed, cut, runs, sessions=1):
    start, end = frames[0]["at"], frames[-1]["at"]
    prompts = sum(_role(f) == "prompt_submit" for f in frames)
    return {"kind": kind, "agent": agent, "session_key": key, "project": project(cwd), "cwd": cwd, "start": start,
            "end": end, "closed": closed, "cut": cut, "sessions": sessions, "frames": frames, "yours": prompts,
            "agent_events": len(frames) - prompts, "away": _away(start, end, runs),
            "requires": sorted({r for f in frames for r in f["requires"]}), "sources": [f["id"] for f in frames]}


def segments(frames, attention_runs, now):
    """The agent-session segments and worker batches of frames by start; a closed one is ready for its L1 summary.
    attention_runs: (start, end, "afk" | "not-afk") of the user's presence. A subagent's frames carry its parent's
    session id, so they are in its parent's segments."""
    sessions = {}
    for frame in sorted(frames, key=lambda f: (f["at"], f["id"])):
        sessions.setdefault((frame["metadata"].get("app"), frame["metadata"].get("label")), []).append(frame)
    result, batches = [], {}
    for (agent, key), rows in sessions.items():
        pieces = _pieces(rows, now)
        cwd = next((f["metadata"]["doc"] for f in reversed(rows) if f["metadata"].get("doc")), None)
        finished = _role(rows[-1]) == "session_end" or now - rows[-1]["at"] >= IDLE
        if cwd and WORKER.match(WORKTREE.sub("", cwd.rstrip("/"))) or finished and (
                rows[-1]["at"] - rows[0]["at"] < WORKER_SPAN and sum(_role(f) == "prompt_submit" for f in rows) == 1):
            hour = datetime.datetime.fromtimestamp(rows[0]["at"]).replace(minute=0, second=0, microsecond=0)
            batches.setdefault((_repo(cwd) if cwd else "", hour), []).append((agent, cwd, rows, finished))
            continue
        result += [_segment("agent_session", agent, key, cwd, p["frames"], p["closed"], p["cut"], attention_runs)
                   for p in pieces]
    for (repo, hour), members in batches.items():
        rows = sorted((f for _, _, frames, _ in members for f in frames), key=lambda f: (f["at"], f["id"]))
        agents = {agent for agent, *_ in members}
        closed = all(finished for *_, finished in members) and now >= (hour + datetime.timedelta(hours=1)).timestamp()
        result.append(_segment("worker_batch", agents.pop() if len(agents) == 1 else None,
                               f"{repo}@{hour:%Y-%m-%dT%H}", members[0][1], rows, closed, "end" if closed else None,
                               attention_runs, sessions=len(members)))
    return sorted(result, key=lambda s: (s["start"], s["session_key"]))


def _content(frame):
    try:
        value = json.loads(frame.get("text") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _output(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and any(isinstance(value.get(k), str) for k in ("stdout", "stderr")):
        return "\n".join(value[k] for k in ("stdout", "stderr") if isinstance(value.get(k), str))
    return "" if value is None else _dump(value)


def _paths(inputs, command):
    if isinstance(inputs, dict):
        path = next((inputs[k] for k in ("file_path", "notebook_path", "path") if isinstance(inputs.get(k), str)), None)
        if path:
            return [path]
        inputs = inputs.get("input") if isinstance(inputs.get("input"), str) else command or ""
    return PATCH_FILE.findall(inputs) if isinstance(inputs, str) else []


def _line(role, tool, content):
    """(tag, text) of one frame, or None."""
    if role == "prompt_submit" and isinstance(content.get("prompt"), str):
        prompt = content["prompt"]
        return "user", prompt if len(prompt) <= PROMPT_HEAD + PROMPT_TAIL else (
            prompt[:PROMPT_HEAD] + "…" + prompt[-PROMPT_TAIL:])
    if role in ("stop", "subagent_stop"):
        message = content.get("last_assistant_message") or content.get("result")
        return ("agent", message[:AGENT_TEXT]) if isinstance(message, str) and message else None
    if not tool:
        return None
    inputs = content.get("tool_input")
    command = command_text(inputs)
    output = _output(content.get("tool_response", content.get("tool_output")))
    code = EXIT.match(output.lstrip())
    failed = role == "tool_failure" or code is not None and code[1] != "0" or (
        isinstance(content.get("tool_response"), dict) and content["tool_response"].get("is_error") is True)
    if command and TEST_CMD.search(command):
        counts = [line.strip()[:PREVIOUS_TEXT] for line in output.splitlines() if COUNT.search(line.strip())][-3:]
        outcome = " | ".join(counts) if counts else f"exit {code[1]}" if code else "failed" if failed else ""
        return "check", (command[:COMMAND_TEXT] + (" → " + outcome if outcome else ""))[:LINE_TEXT]
    if failed:
        target = command or ", ".join(_paths(inputs, None)) or tool
        return "fail", f"{tool}: {target[:COMMAND_TEXT]} → {output.strip()[-COMMAND_TEXT:]}"[:LINE_TEXT]
    paths = _paths(inputs, command) if tool_category(tool) == "write" or command and PATCH_FILE.search(command) else []
    if paths:
        return "edit", ", ".join(paths)[:LINE_TEXT]
    return ("cmd", command[:COMMAND_TEXT]) if command else None


def _kept(lines):
    """The first prompt and the LATEST lines of each tag, an edited path once at its latest."""
    first = next((line for line in lines if line["tag"] in PROMPT_TAGS), None)
    kept, counts, edited = [], {}, set()
    for line in reversed(lines):
        if line["tag"] == "edit":
            if line["text"] in edited:
                continue
            edited.add(line["text"])
        counts[line["tag"]] = counts.get(line["tag"], 0) + 1
        if counts[line["tag"]] <= LATEST[line["tag"]] or line is first:
            kept.append(line)
    return kept[::-1]


def _fit(made):
    """made with lines dropped by DROP_ORDER until it is at most LIMIT characters as JSON."""
    lines = made["lines"]
    first = next((line for line in lines if line["tag"] in PROMPT_TAGS), None)
    order = [line for tag in DROP_ORDER for line in lines if line["tag"] == tag and line is not first]
    order += [first] if first is not None else []
    for line in order:
        if len(_dump({**made, "lines": lines})) <= LIMIT:
            break
        lines = [kept for kept in lines if kept is not line]
    return {**made, "lines": lines}


def _in_worktree(cwd):
    """A worker's checkout: its prompts are the orchestrating agent's tasks, not the user's words."""
    return bool(cwd) and bool(WORKER.match(cwd.rstrip("/")) or AGENT_WORKTREE.search(cwd))


def digest(segment, previous):
    """The L1 model input of segment, whose frames carry their text; at most LIMIT characters as JSON.
    previous: title, status and next_steps (texts) of the summary before it in its session, or None."""
    lines, tools, subagents = [], {}, 0
    for frame in segment["frames"]:
        role, tool = _role(frame), frame["metadata"].get("subrole")
        if tool:
            tools[tool] = tools.get(tool, 0) + 1
        subagents += role == "subagent_stop"
        line = _line(role, tool, _content(frame))
        if line is not None:
            tag = "orchestrator" if line[0] == "user" and _in_worktree(frame["metadata"].get("doc")) else line[0]
            lines.append({"id": frame["id"], "tag": tag, "text": line[1]})
    if previous is not None:
        previous = {"title": previous["title"][:PREVIOUS_TEXT], "status": previous["status"],
                    "next_steps": [text[:PREVIOUS_TEXT] for text in previous["next_steps"]]}
    iso = lambda at: datetime.datetime.fromtimestamp(at).isoformat(timespec="minutes")  # noqa: E731
    return _fit({"kind": segment["kind"], "agent": segment["agent"], "project": segment["project"],
                 "start": iso(segment["start"]), "end": iso(segment["end"]), "away": segment["away"],
                 "sessions": segment["sessions"], "subagents": subagents,
                 "tools": dict(sorted(tools.items(), key=lambda kv: -kv[1])[:TOOLS_KEPT]),
                 "lines": _kept(lines), "previous": previous})
