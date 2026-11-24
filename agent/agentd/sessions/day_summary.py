"""One day of agent work for the evening report:counts from the harness ledger, names of the sessions waiting.
Only names and numbers: never a command, a target or a title."""
import datetime
import functools
import os
from pathlib import Path
import subprocess

from sessions import git_state
from sessions.ledger import parse
from character.proactive import WAITING
from sessions.registry import own_app_wait

LINE_MAX = 200  # characters of an own session's last_line shown, as sessions.own.LINE_MAX


@functools.lru_cache(maxsize=64)
def project_root(cwd):
    """The directory the harness names cwd's ledger folder after: a git worktree's main tree root, else cwd itself.
    A removed worktree is looked up from its nearest existing parent."""
    probe = Path(cwd)
    while not probe.is_dir() and probe != probe.parent:
        probe = probe.parent
    try:
        found = git_state.run(str(probe), ("rev-parse", "--path-format=absolute", "--git-common-dir"), 5,
                              text=True, encoding="utf-8")
    except (OSError, subprocess.SubprocessError):
        return cwd
    if found is None:
        return cwd
    common = found.stdout.strip()
    return os.path.dirname(common) if found.returncode == 0 and os.path.basename(common) == ".git" else cwd


def _ledger_paths(ledger_root, day):
    return () if ledger_root is None else sorted(Path(ledger_root).glob(f"*/{day}/*.jsonl"))


def summarize(ledger_root, day, registry_snapshot, own_sessions):
    """Local day, optional external ledger root, registry snapshot, and OwnSession.to_dict() rows."""
    starts, gates = set(), {}  # (project, session id) started; (project, session id) -> (ts, n, passed) of its last gate
    done = failed = blocks = n = 0
    for path in _ledger_paths(ledger_root, day):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for entry in filter(None, map(parse, lines)):
            name, attrs, n = entry["event_name"], entry["attributes"], n + 1
            sid = attrs.get("session.id")
            session = (path.parent.parent.name, sid if isinstance(sid, str) else None)
            if name == "session.start":
                starts.add(session)
            elif name == "agent.end":
                done, failed = (done + 1, failed) if attrs.get("state") == "done" else (done, failed + 1)
            elif name == "gate.result":
                # A session may write several files; the latest timestamp wins, then the later line.
                last = (entry["ts"] or 0, n, attrs.get("outcome") != "fail")
                gates[session] = max(gates.get(session, last), last)
            elif name == "guard.block":
                blocks += 1
    gates = [passed for _, _, passed in gates.values()]
    waiting = [{"name": os.path.basename(s["cwd"] or "") or s["display_session"], "state": s["effective_state"],
                **({"word": word} if (word := own_app_wait(s)) else {})}
               for s in registry_snapshot["sessions"] if s["effective_state"] in WAITING]
    own_today = [s for s in own_sessions
                 if datetime.date.fromtimestamp(s["started_at"]).isoformat() == day]
    waiting += [{"name": os.path.basename(s["cwd"]) or s["session_id"], "state": s["state"]}
                for s in own_sessions if s["state"] in WAITING]
    return {"sessions": len(starts), "agents_done": done, "agents_failed": failed,
            "gates_green": sum(gates), "gates_red": len(gates) - sum(gates),
            "guard_blocks": blocks, "own_sessions": len(own_today), "waiting": waiting}


def segments(ledger_root, day, own_sessions):
    """Per-project detail of one day for the UI and diagnostics, never for speech; arguments as summarize."""
    groups, gates, n = {}, {}, 0  # project -> group; (project, session id) -> (ts, n, passed) of its last gate

    def group(project):
        return groups.setdefault(project, {"project": project, "name": None, "sessions": {}, "own": []})

    for path in _ledger_paths(ledger_root, day):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        project = path.parent.parent.name
        for entry in filter(None, map(parse, lines)):
            name, attrs, ts, n = entry["event_name"], entry["attributes"], entry["ts"], n + 1
            sid = attrs.get("session.id")
            if not isinstance(sid, str):  # a line without a session has no row to count into
                continue
            row = group(project)["sessions"].setdefault(sid, {
                "session_id": sid, "started_at": None, "ended_at": None, "agents_done": 0, "agents_failed": 0,
                "last_gate": None, "guard_blocks": 0})
            if ts is not None:
                row["started_at"] = ts if row["started_at"] is None else min(row["started_at"], ts)
                row["ended_at"] = ts if row["ended_at"] is None else max(row["ended_at"], ts)
            if name == "agent.end":
                row["agents_done" if attrs.get("state") == "done" else "agents_failed"] += 1
            elif name == "gate.result":
                last = (ts or 0, n, attrs.get("outcome") != "fail")
                if last >= gates.get((project, sid), last):
                    gates[(project, sid)] = last
                    row["last_gate"] = {"at": ts, "passed": last[2]}
            elif name == "guard.block":
                row["guard_blocks"] += 1
    for s in own_sessions:
        if datetime.date.fromtimestamp(s["started_at"]).isoformat() != day:
            continue
        root = project_root(s["cwd"])
        g = group(root.replace("/", "-"))
        g["name"] = g["name"] or os.path.basename(root)
        line = s["last_line"]
        g["own"].append({"session_id": s["session_id"], "title": s["title"], "state": s["state"],
                         "last_line": line[:LINE_MAX] if line is not None else None,
                         "started_at": s["started_at"], "updated_at": s["updated_at"], "task_id": s.get("task_id")})

    def first(starts):  # rows without any timestamp sort last
        return min((t for t in starts if t is not None), default=float("inf"))

    result = []
    for g in groups.values():
        g["sessions"] = sorted(g["sessions"].values(), key=lambda r: (first([r["started_at"]]), r["session_id"]))
        g["own"].sort(key=lambda o: o["started_at"])
        g["name"] = g["name"] or g["project"].split("-")[-1]
        result.append(g)
    return sorted(result, key=lambda g: (first([r["started_at"] for r in g["sessions"]] +
                                               [o["started_at"] for o in g["own"]]), g["project"]))
