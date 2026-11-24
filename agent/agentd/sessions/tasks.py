"""Persistent task ledger: one row per dispatched task and an event per state change, so a restart can explain it."""
import hashlib
import json
import shlex
import subprocess
import threading
import time

from infra.platform import command_line, new_group_options, release_group, signal_group, track_group
from sessions import git_state
from tool_gateway.policy import POLICY, READ_ONLY_PRESETS

TRANSITIONS = {
    "proposed": ("approved", "denied", "expired", "cancelled"),
    "approved": ("running", "cancelled", "expired"),
    "running": ("returned", "failed", "cancelled", "interrupted", "waiting_user"),
    "waiting_user": ("cancelled", "interrupted"),
    "returned": ("verifying", "interrupted"),
    "verifying": ("succeeded", "failed", "needs_review", "interrupted"),
    "needs_review": ("succeeded", "failed", "accepted", "rejected"),
    "succeeded": ("accepted", "rejected"), "accepted": (), "rejected": (), "failed": (), "denied": (), "expired": (), "cancelled": (),
    "interrupted": (),
}
RESTART = {"proposed": "expired", "approved": "expired", "running": "interrupted", "returned": "interrupted",
           "verifying": "interrupted"}
VERIFY_TIMEOUT = 120
TAIL_BYTES = 4096
COLUMNS = ("task_id", "target", "cwd", "title", "mode", "state", "verify_cmd", "session_id", "created_at",
           "updated_at", "result_json", "requested_by")
SELECT = f"SELECT {', '.join(COLUMNS)} FROM tasks"


def check_verify(mode, cmd):
    """The verify command as stored, None when there is none; raises ValueError("invalid_verify_cmd")."""
    if not cmd:
        return None
    cmd = cmd.strip()
    if not POLICY.verify_command(mode, cmd):
        raise ValueError("invalid_verify_cmd")
    try:
        verify_argv(cmd)
    except ValueError:
        raise ValueError("invalid_verify_cmd") from None
    return cmd


def verify_argv(cmd):
    """What run_verify starts for a stored verify command; raises ValueError when it cannot be split."""
    return command_line(cmd)


def delivery_id(task_id):
    """The id of what a coding task returned; its verify result keeps it and a user review records it."""
    return "delivery-" + hashlib.sha256(("task:" + task_id).encode()).hexdigest()[:32]


def run_verify(argv, cwd, timeout):
    """(exit code, the last TAIL_BYTES of stdout and stderr); raises subprocess.TimeoutExpired carrying that tail.

    No stdin, and its own process group: what the verifier starts ends with it, or at the timeout. A read_only
    preset runs as hardened git."""
    preset = READ_ONLY_PRESETS.get(shlex.join(argv))
    if preset is not None:
        done = git_state.run(cwd, preset, timeout)
        if done is None:  # git is unavailable
            raise FileNotFoundError("git_unavailable")
        return done.returncode, (done.stdout + done.stderr)[-TAIL_BYTES:]
    proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, **new_group_options())
    try:
        try:
            track_group(proc)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        tail = bytearray()

        def drain():
            for chunk in iter(lambda: proc.stdout.read1(65536), b""):
                tail.extend(chunk)
                del tail[:-TAIL_BYTES]
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            code = proc.wait(timeout)
        except subprocess.TimeoutExpired:
            code = None
        try:
            signal_group(proc, force=True)
        except (ProcessLookupError, PermissionError):  # nothing of the group is left; Darwin: only exiting members
            pass
        proc.wait()
        reader.join(timeout)  # bounded: a process that left the group can hold the pipe open
        if code is None:
            raise subprocess.TimeoutExpired(argv, timeout, output=bytes(tail))
        return code, bytes(tail)
    finally:
        release_group(proc)


def _row(row):
    if row is None:
        return None
    task = dict(zip(COLUMNS, row))
    result = task.pop("result_json")
    task["result"] = None if result is None else json.loads(result)
    task["requested_by"] = None if task["requested_by"] is None else json.loads(task["requested_by"])
    return task


def _tail(output):
    return (output or b"")[-TAIL_BYTES:].decode("utf-8", "replace")


class TaskLedger:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.Lock() if lock is None else lock

    def _event(self, task_id, kind, at, attrs):
        seq = self.db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = ?",
                              (task_id,)).fetchone()[0]
        self.db.execute("INSERT INTO task_events (task_id, seq, kind, at, attrs_json) VALUES (?, ?, ?, ?, ?)",
                        (task_id, seq, kind, at, json.dumps(attrs, ensure_ascii=False) if attrs else None))

    def _get(self, task_id):
        return _row(self.db.execute(f"{SELECT} WHERE task_id = ?", (task_id,)).fetchone())

    def create(self, task_id, target, cwd, title, mode, verify_cmd=None, now=None, requested_by=None):
        """A proposed task; the existing row when task_id is already there."""
        verify_cmd = check_verify(mode, verify_cmd)
        now = self.clock() if now is None else now
        with self.lock:
            existing = self._get(task_id)
            if existing is not None:
                return existing
            self.db.execute("INSERT INTO tasks (task_id, target, cwd, title, mode, state, verify_cmd, created_at,"
                            " updated_at, requested_by) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
                            (task_id, target, cwd, title, mode, verify_cmd, now, now,
                             json.dumps(requested_by, ensure_ascii=False) if requested_by is not None else None))
            self._event(task_id, "proposed", now, None)
            self.db.commit()
            return self._get(task_id)

    def transition(self, task_id, state, now=None, **attrs):
        now = self.clock() if now is None else now
        with self.lock:
            task = self._get(task_id)
            if task is None:
                raise ValueError("unknown_task")
            if state not in TRANSITIONS[task["state"]]:
                raise ValueError("illegal_transition")
            sets, args = ["state = ?", "updated_at = ?"], [state, now]
            for column in ("session_id", "mode", "verify_cmd"):  # mode and verify_cmd: as the card was allowed
                if column in attrs:
                    sets.append(f"{column} = ?")
                    args.append(attrs[column])
            if "result" in attrs:
                sets.append("result_json = ?")
                args.append(json.dumps(attrs["result"], ensure_ascii=False))
            self.db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE task_id = ?", (*args, task_id))
            self._event(task_id, state, now, attrs)
            self.db.commit()
            return self._get(task_id)

    def verify(self, task_id, runner=None, now=None):
        """Run a returned task's verify command in its cwd; its exit code decides succeeded or failed."""
        task = self.transition(task_id, "verifying", now=now)
        delivery = {"delivery_id": delivery_id(task_id)}
        if task["verify_cmd"] is None:
            result = {"exit_code": None, "output_tail": None, "reason": "no_verify_cmd", **delivery}
            return self.transition(task_id, "needs_review", now=now, result=result)
        try:
            code, output = (runner or run_verify)(verify_argv(task["verify_cmd"]), task["cwd"], VERIFY_TIMEOUT)
        except subprocess.TimeoutExpired as timeout:
            output = (timeout.stdout or b"") + (timeout.stderr or b"")
            result = {"exit_code": None, "output_tail": _tail(output), "reason": "timeout", **delivery}
            return self.transition(task_id, "failed", now=now, result=result)
        except (OSError, ValueError) as error:  # the program is missing or cannot run in cwd; a row stored unsplittable
            result = {"exit_code": None, "output_tail": str(error)[-TAIL_BYTES:], "reason": "not_started", **delivery}
            return self.transition(task_id, "failed", now=now, result=result)
        result = {"exit_code": code, "output_tail": _tail(output), "reason": None, **delivery}
        return self.transition(task_id, "succeeded" if code == 0 else "failed", now=now, result=result)

    def recover(self, now=None):
        """At startup: tasks a restart cut off end as expired or interrupted; [(task_id, new state)]."""
        with self.lock:
            rows = self.db.execute(f"SELECT task_id, state FROM tasks WHERE state IN ({', '.join('?' * len(RESTART))})",
                                   tuple(RESTART)).fetchall()
        return [(task_id, self.transition(task_id, RESTART[state], now=now, reason="restart")["state"])
                for task_id, state in rows]

    def resume_character(self, task_id, *, now=None):
        """An explicit user continuation starts a new character attempt, retaining task identity."""
        now = self.clock() if now is None else now
        with self.lock:
            task = self._get(task_id)
            if task is None or task["target"] != "character":
                raise ValueError("unknown_character_task")
            if task["state"] not in ("interrupted", "failed", "cancelled", "needs_review", "succeeded", "waiting_user", "rejected"):
                raise ValueError("task_still_running")
            # Resumed and running in one commit: a stored approved would expire at the next start.
            self.db.execute("UPDATE tasks SET state='running',updated_at=?,result_json=NULL WHERE task_id=?", (now, task_id))
            self._event(task_id, "resumed", now, {"previous_state": task["state"]})
            self._event(task_id, "running", now, None)
            self.db.commit()
            return self._get(task_id)

    def get(self, task_id):
        with self.lock:
            return self._get(task_id)

    @staticmethod
    def review_in_transaction(db, task_id, state, decision, now):
        """Join the delivery transaction on the shared file, even with a separate ledger connection."""
        if not db.in_transaction or state not in ('accepted', 'rejected'):
            raise ValueError('task_review_transaction_required')
        task = _row(db.execute(SELECT + ' WHERE task_id=?', (task_id,)).fetchone())
        if task is None or task['state'] not in ('needs_review', 'succeeded'):
            raise ValueError('task_not_reviewable')
        result = dict(task['result'] or {})
        result['user_acceptance'] = {**decision, 'state': state}
        db.execute('UPDATE tasks SET state=?,updated_at=?,result_json=? WHERE task_id=?',
                   (state, now, json.dumps(result, ensure_ascii=False), task_id))
        seq = db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM task_events WHERE task_id=?', (task_id,)).fetchone()[0]
        db.execute('INSERT INTO task_events VALUES(?,?,?,?,?)', (task_id, seq, state, now,
                   json.dumps({'source': 'user', 'delivery_id': decision['delivery_id']}, ensure_ascii=False)))

    def list(self, limit=50):
        with self.lock:
            rows = self.db.execute(f"{SELECT} ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [_row(row) for row in rows]

    def agent_dispatches(self, character_id, *, task_id=None, limit=5, since=None):
        where = "json_extract(requested_by, '$.kind') = 'agent' AND json_extract(requested_by, '$.character_id') = ?"
        args = [character_id]
        if task_id is not None:
            where += " AND task_id = ?"
            args.append(task_id)
        if since is not None:
            where += " AND created_at >= ?"
            args.append(since)
        with self.lock:
            # rowid breaks ties: Windows' 15.6 ms clock gives tasks created together one created_at.
            rows = self.db.execute(f"{SELECT} WHERE {where} ORDER BY created_at DESC, rowid DESC LIMIT ?",
                                   (*args, limit)).fetchall()
        return [_row(row) for row in rows]
