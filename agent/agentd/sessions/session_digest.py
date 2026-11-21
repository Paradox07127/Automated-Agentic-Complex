"""Events from a Claude Code session transcript, main or subagent, read incrementally from a byte offset.

Claude Code writes a session as JSONL at ~/.claude/projects/<cwd>/<sessionId>.jsonl and each subagent's at
<sessionId>/subagents/agent-<agentId>.jsonl, next to agent-<agentId>.meta.json. None of these formats is documented:
a line that does not parse, a record that is not a dict and a field of another type read as absent. The read state
holds only JSON values, so a read resumed from a saved state gives the same events as one read straight through."""
import copy
import datetime
import hmac
import json
import re

TEXT_MAX = 8000
KINDS = ("human", "delegated", "reply", "tool_call", "tool_result", "check", "commit", "wait")
CALL_TEXT = 2000  # characters kept of a Bash command, and from the end of a tool result
INPUT_TEXT = 500  # characters kept of another tool's input as JSON
HEAD = 200  # characters kept of a check command, a count line and a commit subject
COUNTS_KEPT = 8

FILE_TOOLS = ("Read", "Edit", "Write", "NotebookEdit")
INPUT_FIELD = {"Grep": "pattern", "Glob": "pattern", "WebFetch": "url", "WebSearch": "query"}
ASKED = ("user_temporary", "user_permanent")
# their results carry what the user typed (an answer, the reason for a refusal), so they need consent like a prompt
USER_TOOLS = ("AskUserQuestion", "ExitPlanMode", "unknown")  # "unknown": a result whose call was not read may be one
INTERRUPTED = "[Request interrupted by user"

TEST_CMD = re.compile(r"unittest|pytest|swift test|xcodebuild\b.*\btest|_gate\.sh|\bgate\.sh|npm (run )?test|cargo test"
                      r"|go test")
COUNT = re.compile(r"Ran \d+ tests?|\d+ passed|\d+ failed|GATE PASS|GATE FAIL|\bFAILED\b|Executed \d+ tests?|^OK\b")
FAIL = re.compile(r"GATE FAIL|\bFAILED\b|\b[1-9]\d* failed")
COMMIT_CMD = re.compile(r"\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b[^;&|\n]*")  # up to the next command
NOT_COMMIT = re.compile(r"--dry-run|--help")  # git commit -n is --no-verify, a real commit
COMMIT_LINE = re.compile(r"^\[[^\]\s]+ ([0-9a-f]{7,40})\] (.*)$", re.M)
ONELINE = re.compile(r"^([0-9a-f]{7,40}) (.*)$", re.M)
EXIT_TEXT = re.compile(r"Exit code (\d+)")
EXIT_ERROR = re.compile(r"Error: Exit code (\d+)")
EXIT_NOTICE = re.compile(r"exit code (\d+)", re.I)
AGENT_ID = re.compile(r"[0-9a-f]{17}")
TAGS = {tag: re.compile(rf"<{tag}>(.*?)</{tag}>", re.S) for tag in ("task-id", "tool-use-id", "status", "summary",
                                                                     "result")}


def new_state(path, session_id, agent_id=None, invocation_id=None):
    return {"path": path, "session_id": session_id, "agent_id": agent_id, "invocation_id": invocation_id,
            "offset": 0, "line": 0, "seen": [], "tools": {}, "launches": {}}


def read(state, hash_key, human_text):
    """(events from the complete lines after state["offset"], the state to read on from); state is not changed.
    Without human_text a human event keeps only the length and keyed hash of its text."""
    state = copy.deepcopy(state)
    with open(state["path"], "rb") as f:
        f.seek(state["offset"])
        data = f.read()
    done = data.rfind(b"\n") + 1  # a line without its newline yet is read again next time
    reader = _Reader(state, hash_key, human_text)
    for line in data[:done].split(b"\n")[:-1]:
        reader.line(line)
        state["offset"] += len(line) + 1
        state["line"] += 1
    return reader.events, state


def subagent_invocation(meta_path):
    """toolUseId of a subagent's agent-<id>.meta.json, the parent's Agent tool_use id; None when it cannot be read."""
    try:
        with open(meta_path, "rb") as f:
            meta = json.loads(f.read())
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    return _str(meta.get("toolUseId")) or None


def _str(value):
    return value if isinstance(value, str) else None


def _kind(origin):
    return _str(origin.get("kind")) if isinstance(origin, dict) else None


def _dicts(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _text(content):
    """A string content as is, a block list's text blocks joined by lines; None for anything else."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b["text"] for b in _dicts(content) if b.get("type") == "text" and isinstance(b.get("text"), str))
    return None


def _ts(value):
    try:
        moment = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)).timestamp()


def _judge(command, text, exit_status, background):
    """("check", fields) for a test command or a result with count lines, else ("tool_result", None)."""
    counts = [line.strip()[:HEAD] for line in text.splitlines() if COUNT.search(line)][:COUNTS_KEPT]
    if not counts and not (command is not None and TEST_CMD.search(command)):
        return "tool_result", None
    if INTERRUPTED in text:
        result = "unknown"
    elif FAIL.search(text) or exit_status not in (0, None):
        result = "fail"
    else:
        result = "pass" if exit_status == 0 else "unknown"
    return "check", {"command": command[:HEAD] if command is not None else None, "result": result,
                     "exit": exit_status, "counts": counts, "background": background}


class _Reader:
    def __init__(self, state, hash_key, human_text):
        self.state, self.hash_key, self.human_text = state, hash_key, human_text
        self.seen = set(state["seen"])
        self.events = []

    def line(self, line):
        try:
            record = json.loads(line)
        except ValueError:
            return
        if not isinstance(record, dict) or record.get("type") not in ("user", "assistant", "attachment"):
            return
        uuid = _str(record.get("uuid"))
        if not uuid or uuid in self.seen:  # a re-appended copy of an earlier record
            return
        self.seen.add(uuid)
        self.state["seen"].append(uuid)
        self.record, self.uuid, self.count = record, uuid, 0
        if record["type"] == "assistant":
            self._assistant(record)
        elif record["type"] == "user":
            self._user(record)
        else:
            self._attachment(record)

    def _emit(self, kind, text, private=False, **fields):
        """private: text the user may have typed, kept like a human event's only with human_text."""
        state, record = self.state, self.record
        event = {"event_id": f"{state['agent_id'] or state['session_id']}/{self.uuid}/{self.count}",
                 "session_id": state["session_id"], "agent_id": state["agent_id"], "invocation_id": None,
                 "path": state["path"], "offset": state["offset"], "seq": state["line"],
                 "ts": _ts(record.get("timestamp")), "kind": kind, "tool": None, "text": None, "text_len": 0,
                 "text_hash": None, "cut": False, "cwd": _str(record.get("cwd")), "branch": _str(record.get("gitBranch")),
                 "files": [], "untagged": False, "check": None, "commit": None, "wait": None, "permission": None,
                 "status": None, **fields}
        if state["agent_id"] is not None:
            event["invocation_id"] = state["invocation_id"]
        if text is not None:
            event["text_len"] = len(text)
            event["text_hash"] = hmac.new(self.hash_key, text.encode(), "sha256").hexdigest()
            if kind != "human" and not private or self.human_text:
                event["text"], event["cut"] = text[:TEXT_MAX], len(text) > TEXT_MAX
        self.events.append(event)
        self.count += 1

    def _assistant(self, record):
        message = record.get("message")
        for block in _dicts(message.get("content") if isinstance(message, dict) else None):
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                self._emit("reply", block["text"])
            elif block.get("type") == "tool_use":
                self._call(block)

    def _call(self, block):
        name, use_id = _str(block.get("name")), _str(block.get("id"))
        given = block.get("input")
        given = given if isinstance(given, dict) else {}
        kind, fields = "tool_call", {"tool": name}
        if name == "Bash":
            text = _str(given.get("command"))
            text = text[:CALL_TEXT] if text is not None else None
        elif name in ("Agent", "Task"):
            text, fields["invocation_id"] = _str(given.get("description")), use_id
        elif name in FILE_TOOLS:
            text = _str(given.get("notebook_path" if name == "NotebookEdit" else "file_path"))
            fields["files"] = [text] if text else []
        elif name in INPUT_FIELD:
            text = _str(given.get(INPUT_FIELD[name]))
        elif name == "AskUserQuestion":
            text = "\n".join(q["question"] for q in _dicts(given.get("questions")) if isinstance(q.get("question"), str))
            kind, fields["wait"] = "wait", "question"
        elif name == "mcp__ccd_turn__wrap_up":
            text = _str(given.get("recap"))
            if _str(given.get("ask")):
                text, kind, fields["wait"] = given["ask"], "wait", "ask"
            elif given.get("blocked") is True:
                kind, fields["wait"] = "wait", "blocked"
        elif name == "mcp__ccd_turn__update_plan":
            text = "\n".join(i["content"] for i in _dicts(given.get("items")) if isinstance(i.get("content"), str))
        else:
            text = json.dumps(given, ensure_ascii=False, sort_keys=True)[:INPUT_TEXT]
        if use_id is not None:
            self.state["tools"][use_id] = [name, text]
        self._emit(kind, text, **fields)

    def _user(self, record):
        origin = _kind(record.get("origin"))
        if origin == "plugin" or record.get("isCompactSummary") is True:
            return
        message = record.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if origin == "peer" and record.get("handback") is True:
            self._emit("tool_result", _text(content), tool="Agent",
                       invocation_id=self.state["launches"].get(_str(record.get("senderTaskId"))))
            return
        if record.get("isMeta") is True:
            return
        text = _text(content)
        subagent = self.state["agent_id"] is not None
        if origin == "task-notification":
            self._notification(text)
        elif origin == "human":
            if text is not None:
                self._emit("human", text)
        elif subagent and (origin == "coordinator" or origin is None and "parentUuid" in record
                           and record["parentUuid"] is None):
            if text is not None:
                self._emit("delegated", text)
        elif origin is None:
            for block in _dicts(content):
                if block.get("type") == "tool_result":
                    self._result(record, block)
            if text and text.lstrip() and not text.lstrip().startswith(("<", "[")):
                self._emit("human", text, untagged=True)

    def _attachment(self, record):
        attachment = record.get("attachment")
        if not isinstance(attachment, dict) or attachment.get("type") != "queued_command":
            return
        origin, text = _kind(attachment.get("origin")), _text(attachment.get("prompt"))
        if origin == "task-notification":
            self._notification(text)
        elif text is None:
            return
        elif origin == "human":
            self._emit("human", text)
        elif origin == "coordinator" and self.state["agent_id"] is not None:
            self._emit("delegated", text)

    def _result(self, record, block):
        tools, launches = self.state["tools"], self.state["launches"]
        use_id = _str(block.get("tool_use_id"))
        name, command = tools.get(use_id) or ["unknown", None]
        result = _text(block.get("content"))
        text = result[-CALL_TEXT:] if result is not None else None
        result = result or ""
        outcome = record.get("toolUseResult")
        details = outcome if isinstance(outcome, dict) else {}
        decision = record.get("permissionDecision")
        source = decision.get("source") if isinstance(decision, dict) else None
        fields = {"tool": name, "permission": source if source in ASKED else None,
                  "private": name in USER_TOOLS or source in ASKED}
        launched = details.get("status") == "async_launched"
        if launched or name == "Bash" and _str(details.get("backgroundTaskId")):
            task = _str(details.get("agentId" if launched else "backgroundTaskId"))
            if task and use_id:
                launches[task] = use_id
            self._emit("tool_result", text, invocation_id=use_id, **fields)
            return
        tools.pop(use_id, None)
        if name != "Bash":
            self._emit("tool_result", text, **fields)
            return
        exit_status = None
        if block.get("is_error") is False:
            exit_status = None if "returnCodeInterpretation" in details else 0
        elif block.get("is_error") is True:
            found = EXIT_TEXT.match(result) or (EXIT_ERROR.match(outcome) if isinstance(outcome, str) else None)
            exit_status = int(found.group(1)) if found else None
        hidden = fields["private"] and not self.human_text  # no counts or subject from what the user may have typed
        commit = COMMIT_CMD.search(command) if exit_status == 0 and command is not None else None
        if commit and not NOT_COMMIT.search(commit.group(0)):
            found = COMMIT_LINE.search(result) or ONELINE.search(result)
            if found:
                self._emit("commit", text, commit={"hash": found.group(1),
                                                   "subject": None if hidden else found.group(2)[:HEAD]}, **fields)
                return
        kind, check = _judge(command, "" if hidden else result, exit_status, False)
        self._emit(kind, text, check=check, **fields)

    def _notification(self, text):
        """A background Agent's or Bash's final status; other notifications (Monitor) are skipped."""
        if text is None:
            return
        tags = {tag: found.group(1) for tag, pattern in TAGS.items() if (found := pattern.search(text))}
        task, use_id = (tags[t].strip() if t in tags else None for t in ("task-id", "tool-use-id"))
        status = tags["status"].strip() if "status" in tags else None
        launches = self.state["launches"]
        invocation = launches[task] if task in launches else use_id or None
        call = self.state["tools"].get(invocation)
        name = call[0] if call else "Agent" if task and AGENT_ID.fullmatch(task) else None
        if name in ("Agent", "Task"):
            self._emit("tool_result", tags.get("result", tags.get("summary")), tool="Agent", invocation_id=invocation,
                       status=status)
        elif name == "Bash":
            found = EXIT_NOTICE.search(text)
            kind, check = _judge(call[1], text, int(found.group(1)) if found else None, True)
            self._emit(kind, text[-CALL_TEXT:], tool="Bash", invocation_id=invocation, check=check, status=status)
        else:
            return
        self.state["tools"].pop(invocation, None)
        launches.pop(task, None)
