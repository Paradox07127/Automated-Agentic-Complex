"""C8 runner for the local Claude Code CLI over its headless stream-json protocol.

Endfield's tools reach `claude -p` through tool_bridge.py, a stdio MCP server the CLI
launches itself, which calls back into this process over a private IPC endpoint guarded
by a per-process token. With config native_tools the CLI keeps its own tools, the user's
settings and MCP servers, works in config workspace_dir, and asks the bridge's
permission tool, which becomes a permission_request frame. Without it the CLI has no
built-in tools, settings sources or MCP server but Endfield's, only the bridge's tools
are allowed and nothing that would prompt for permission is asked.
The CLI owns its login.
"""
import asyncio
from collections import defaultdict, deque
import json
import os
from pathlib import Path
import secrets
import shutil
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from character_agent.harness.acp_runner import ask_user_prompt, mcp_result
    from character_agent.harness.codex_runner import (Runner, RunnerFailure, TOOL_NAME, classify_failure, end_child,
                                                      history_prompt, preview_input)
    from character_agent.harness.tool_bridge import BridgeServer
    from character_agent.harness.transport import MAX_FRAME
else:
    from .acp_runner import ask_user_prompt, mcp_result
    from .codex_runner import Runner, RunnerFailure, TOOL_NAME, classify_failure, end_child, history_prompt, preview_input
    from .tool_bridge import BridgeServer
    from .transport import MAX_FRAME

TOOL_PREFIX = "mcp__agentic_complex__"
CLI_EXITED = "claude_cli_exited"
CLI_ENV = {"CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1"}
ISOLATED_ENV = {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "ENABLE_TOOL_SEARCH": "false"}
PERMISSION_TOOL = "endfield_permission"
REMINDER_HOOK = "endfield_tool_reminder"
# --permission-prompt-tool is called with {tool_name, input, tool_use_id} and answers one text block of
# {"behavior": "allow"} or {"behavior": "deny", "message": ...}.
PERMISSION_SCHEMA = {"type": "object", "properties": {"tool_name": {"type": "string"}, "input": {"type": "object"},
                                                      "tool_use_id": {"type": "string"}}, "required": ["tool_name", "input"]}
PERMISSION_OPTIONS = [{"option_id": "allow_once", "name": "Allow", "kind": "allow_once"},
                      {"option_id": "reject_once", "name": "Reject", "kind": "reject_once"}]
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def cli_argv(cli, config, system_prompt, mcp_config, tool_names):
    native = config.get("native_tools") is True
    argv = [cli, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages"]
    if native:
        argv += ["--mcp-config", json.dumps(mcp_config), "--permission-prompt-tool", TOOL_PREFIX + PERMISSION_TOOL,
                 "--no-session-persistence", "--no-chrome"]
    else:
        argv += ["--tools", "", "--mcp-config", json.dumps(mcp_config), "--strict-mcp-config",
                 "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "",
                 "--no-session-persistence", "--no-chrome", "--disable-slash-commands"]
        if tool_names:
            argv += ["--allowedTools", ",".join(TOOL_PREFIX + name for name in sorted(tool_names))]
    # The = form keeps a value that starts with "-" from reading as an option.
    if system_prompt:
        argv.append(("--append-system-prompt=" if native else "--system-prompt=") + system_prompt)
    if config.get("model"):
        argv.append("--model=" + config["model"])
    if config.get("effort"):
        argv += ["--effort", config["effort"]]
    return argv


def result_usage(usage):
    return {key: usage[key] for key in USAGE_KEYS if isinstance(usage, dict) and
            isinstance(usage.get(key), int) and not isinstance(usage.get(key), bool)}


def tool_key(name, args):
    return name, json.dumps(args, sort_keys=True, ensure_ascii=False)


class ClaudeCli:
    """stream-json over the CLI's stdio, one JSON message per line each way; control requests carry a request_id."""

    def __init__(self, argv, env, cwd, on_message, on_exit, on_hook):
        self.argv, self.env, self.cwd = argv, env, cwd
        self.on_message, self.on_exit, self.on_hook = on_message, on_exit, on_hook
        self.proc = None
        self.pending = {}
        self.write_lock = asyncio.Lock()
        self.next_id = 0
        self.reader = None
        self.closed = None

    async def start(self):
        try:
            self.proc = await asyncio.create_subprocess_exec(*self.argv, cwd=self.cwd, env=self.env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=MAX_FRAME)
        except OSError:
            raise RunnerFailure("claude_cli_unavailable") from None
        self.reader = asyncio.create_task(self.read())

    async def write(self, message):
        if self.closed:
            raise RunnerFailure(self.closed)
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        if len(raw) > MAX_FRAME:
            raise RunnerFailure("claude_frame_too_large")
        async with self.write_lock:
            try:
                self.proc.stdin.write(raw)
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                raise RunnerFailure(CLI_EXITED) from None

    async def control(self, request, timeout=30):
        self.next_id += 1
        request_id = "req_" + str(self.next_id)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self.write({"type": "control_request", "request_id": request_id, "request": request})
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise RunnerFailure("claude_control_timeout") from None
        finally:
            self.pending.pop(request_id, None)

    async def read(self):
        failure = CLI_EXITED
        try:
            while True:
                raw = await self.proc.stdout.readline()
                if not raw:
                    break
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("not an object")
                kind = message.get("type")
                if kind == "control_response":
                    response = message.get("response") if isinstance(message.get("response"), dict) else {}
                    future = self.pending.get(response.get("request_id"))
                    if future is None or future.done():
                        continue
                    if response.get("subtype") == "success":
                        future.set_result(response.get("response") if isinstance(response.get("response"), dict) else {})
                    else:
                        future.set_exception(RunnerFailure("claude_control_rejected"))
                elif kind == "control_request":
                    # Permission prompts are off; a hook the runner did not register and anything else asked is refused.
                    request = message.get("request") if isinstance(message.get("request"), dict) else {}
                    output = self.on_hook(request) if request.get("subtype") == "hook_callback" else None
                    asyncio.create_task(self.refuse(message.get("request_id")) if output is None else
                                        self.answer(message.get("request_id"), output))
                elif kind != "control_cancel_request":
                    self.on_message(message)
        except ValueError:
            failure = "claude_invalid_protocol"
        finally:
            self.closed = failure
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RunnerFailure(failure))
            self.on_exit(failure)

    async def refuse(self, request_id):
        try:
            await self.write({"type": "control_response", "response": {"subtype": "error", "request_id": request_id,
                                                                       "error": "Agentic Complex does not answer this request"}})
        except RunnerFailure:
            pass

    async def answer(self, request_id, response):
        try:
            await self.write({"type": "control_response", "response": {"subtype": "success", "request_id": request_id,
                                                                       "response": response}})
        except RunnerFailure:
            pass

    async def disconnect(self):
        if self.proc:
            # The CLI shares the runner's process group, which agentd ends.
            await end_child(self.proc, lambda force: self.proc.kill() if force else self.proc.terminate())
        if self.reader and not self.reader.done():
            self.reader.cancel()


class ClaudeRunner(Runner):
    def __init__(self):
        super().__init__()
        self.session_id = None
        self.model = ""
        self.tools = []
        self.inventory_verified = False
        self.failure = None
        self.ready_sent = False
        # (tool name, canonical args) -> tool_use ids the CLI announced and has not yet called through the bridge.
        self.tool_ids = defaultdict(deque)
        self.seen_tool_ids = set()
        self.total_cost_usd = 0.0
        self.workspace = None
        self.bridge = None
        self.native = False
        self.permissions = {}
        self.tool_reminder = None

    def capabilities(self):
        return {"cancel": "native", "tool_injection": "mcp_stdio", "builtin_tools": "unverified",
                "system_prompt": "native", "usage": "usd", "event_scope": "session", "native_questions": False}

    async def initialize(self, message):
        if self.client is not None:
            raise RunnerFailure("already_initialized")
        config = self.config = message.get("config", {})
        cli, state_dir = config.get("cli_path"), config.get("state_dir")
        self.native = config.get("native_tools") is True
        if not isinstance(cli, str) or not os.path.isabs(cli):
            raise RunnerFailure("local_cli_path_required")
        if not isinstance(state_dir, str) or not os.path.isabs(state_dir):
            raise RunnerFailure("invalid_state_dir")
        if self.native and (not isinstance(config.get("workspace_dir"), str) or not os.path.isabs(config["workspace_dir"])):
            raise RunnerFailure("invalid_workspace_dir")
        definitions = message.get("tools", [])
        if not isinstance(definitions, list) or len(definitions) > 128:
            raise RunnerFailure("invalid_tool_definitions")
        for definition in definitions:
            name = definition.get("name") if isinstance(definition, dict) else None
            if not isinstance(name, str) or not TOOL_NAME.fullmatch(name) or name in self.allowed_names or \
                    name == PERMISSION_TOOL:
                raise RunnerFailure("invalid_tool_name")
            schema = definition.get("input_schema", definition.get("inputSchema"))
            if not isinstance(schema, dict) or schema.get("type") != "object":
                raise RunnerFailure("invalid_tool_schema")
            self.allowed_names.add(name)
            self.tools.append({"name": name, "description": definition.get("description", name), "inputSchema": schema})
        self.model = config.get("model") or ""

        if self.native:
            # The user's Workspace outlives this runner.
            cwd = Path(config["workspace_dir"]).resolve()
        else:
            cwd = self.workspace = Path(state_dir).resolve() / "workspace" / secrets.token_hex(8)
            cwd.mkdir(mode=0o700, parents=True)
        bridged = self.tools + ([{"name": PERMISSION_TOOL, "description": "Ask the Agentic Complex user to approve a tool call",
                                  "inputSchema": PERMISSION_SCHEMA}] if self.native else [])
        self.bridge = BridgeServer(bridged, self.mcp_call)
        await self.bridge.start("efclaude-")
        command, args = self.bridge.command()
        mcp = {"mcpServers": {"agentic_complex": {"type": "stdio", "command": command, "args": args, "env": {}}}}
        env = {**os.environ, **CLI_ENV, **({} if self.native else ISOLATED_ENV)}
        argv = cli_argv(str(Path(cli).resolve()), config, message.get("system_prompt", ""), mcp, self.allowed_names)
        self.client = ClaudeCli(argv, env, str(cwd), self.cli_message, self.cli_exited, self.hook)
        await self.client.start()
        request = {"subtype": "initialize"}
        reminder = config.get("tool_reminder")
        if isinstance(reminder, str) and reminder:
            self.tool_reminder = reminder
            # A null matcher matches every tool, built-in and MCP alike.
            request["hooks"] = {"PostToolUse": [{"matcher": None, "hookCallbackIds": [REMINDER_HOOK]}]}
        info = await self.client.control(request, timeout=120)
        if self.failure:
            raise RunnerFailure(self.failure)
        extra = {"effort_applied": True} if config.get("effort") else {}
        self.emit({"type": "ready", "session_id": self.session_id, "model": self.model, "effort": config.get("effort"),
                   "tool_names": sorted(self.allowed_names), "tool_inventory_verified": self.inventory_verified,
                   "native_tools": self.native, "capabilities": self.capabilities(), "protocol": "claude-stream-json",
                   "cli_version": info.get("claude_code_version") if isinstance(info.get("claude_code_version"), str) else None,
                   "cli_pid": self.client.proc.pid, **extra})
        self.ready_sent = True

    def hook(self, request):
        if not self.tool_reminder or request.get("callback_id") != REMINDER_HOOK:
            return None
        return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": self.tool_reminder}}

    async def mcp_call(self, name, args):
        if self.native and name == PERMISSION_TOOL and isinstance(args, dict):
            allowed = await self.permission(args)
            decision = {"behavior": "allow"} if allowed else {"behavior": "deny", "message": "The user did not allow this"}
            return {"content": [{"type": "text", "text": json.dumps(decision)}]}
        if name not in self.allowed_names or not isinstance(args, dict):
            return {"isError": True, "content": [{"type": "text", "text": "unknown_tool"}]}
        ids = self.tool_ids[tool_key(name, args)]
        # The tool_use id names the call, so its tool_request lines up with the model's own item.
        return mcp_result(await self.tool(name, args, ids.popleft() if ids else None))

    async def permission(self, args):
        run, tool, raw = self.active, args.get("tool_name"), args.get("input")
        if not run or run["cancelled"] or "done" not in run or not isinstance(tool, str):
            return False
        # The bridge's own tools carry their own product approvals.
        if tool.startswith(TOOL_PREFIX) and tool.removeprefix(TOOL_PREFIX) in self.allowed_names:
            return True
        request_id = secrets.token_hex(12)
        future = asyncio.get_running_loop().create_future()
        self.permissions[request_id] = (run["id"], future)
        path = raw.get("file_path") if isinstance(raw, dict) else None
        # The card shows title and locations, not raw_input.
        command = raw.get("command") if isinstance(raw, dict) else None
        frame = {"type": "permission_request", "run_id": run["id"], "request_id": request_id,
                 "title": (f"{tool}: {command}" if isinstance(command, str) else tool)[:500],  # the whole command is in raw_input
                 "kind": None, "locations": [path] if isinstance(path, str) else None,
                 "raw_input": preview_input(raw) if isinstance(raw, dict) else None, "options": PERMISSION_OPTIONS}
        try:
            try:
                self.emit(frame)
            except RunnerFailure:
                self.emit({**frame, "raw_input": {"truncated": True}})
            option_id = await asyncio.wait_for(future, self.config.get("permission_timeout", 180))
        except asyncio.TimeoutError:
            option_id = None
        finally:
            self.permissions.pop(request_id, None)
        return option_id == "allow_once" and not run["cancelled"] and self.active is run

    def _accept(self, message):
        if message.get("type") != "permission_result":
            return super()._accept(message)
        match = self.permissions.get(message.get("request_id"))
        if match and match[0] == message.get("run_id") and not match[1].done():
            match[1].set_result(message.get("option_id"))

    def fail(self, code):
        self.failure = code
        done = self.active.get("done") if self.active else None
        if done and not done.done():
            done.set_exception(RunnerFailure(code))

    def cli_message(self, message):
        kind = message.get("type")
        if kind == "system" and message.get("subtype") == "init":
            if isinstance(message.get("session_id"), str):
                self.session_id = message["session_id"]
            if isinstance(message.get("model"), str) and message["model"]:
                self.model = message["model"]
            # Built-in tools and the user's own MCP servers are expected with native tools.
            if self.native:
                return
            tools = message.get("tools") if isinstance(message.get("tools"), list) else []
            expected = {TOOL_PREFIX + name for name in self.allowed_names}
            # MCP tools may still be connecting at init, so only an extra tool is a failure.
            if any(name not in expected for name in tools):
                self.fail("claude_unexpected_tools")
            self.inventory_verified = set(tools) == expected
            return
        run = self.active
        # A subagent's messages carry the tool_use id that started it; there is no subagent tool here.
        if not run or "done" not in run or message.get("parent_tool_use_id") is not None:
            return
        if kind == "stream_event" and isinstance(message.get("event"), dict):
            self.stream_event(run, message["event"])
        elif kind == "assistant" and isinstance(message.get("message"), dict):
            self.assistant(run, message["message"], message.get("error"))
        elif kind == "result" and not run["done"].done():
            run["done"].set_result(message)

    def stream_event(self, run, event):
        kind = event.get("type")
        if kind == "message_start":
            native = event.get("message") if isinstance(event.get("message"), dict) else {}
            run["message"] = native["id"] if isinstance(native.get("id"), str) else run["id"] + ":" + str(len(run["text_items"]))
        elif kind == "content_block_delta":
            delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
            if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                self.text(run, run["message"] or run["id"] + ":text", delta["text"])
        elif kind == "message_stop" and run["message"]:
            self.complete(run, run["message"])

    def assistant(self, run, native, error):
        content = native.get("content") if isinstance(native.get("content"), list) else []
        text = "".join(b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
        if isinstance(error, str):
            # The CLI's own API error notice, not an answer.
            run["errors"].extend([error, text])
            return
        if isinstance(native.get("model"), str) and native["model"] and not native["model"].startswith("<"):
            self.model = native["model"]
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use" or not isinstance(block.get("id"), str):
                continue
            name = block.get("name")
            if isinstance(name, str) and name.removeprefix(TOOL_PREFIX) in self.allowed_names and \
                    name.startswith(TOOL_PREFIX) and block["id"] not in self.seen_tool_ids and isinstance(block.get("input"), dict):
                self.seen_tool_ids.add(block["id"])
                self.tool_ids[tool_key(name.removeprefix(TOOL_PREFIX), block["input"])].append(block["id"])
        message_id = native["id"] if isinstance(native.get("id"), str) else None
        # Streamed text has already gone out; this covers a reply the CLI got without streaming.
        if text and message_id and message_id not in run["text_items"]:
            self.text(run, message_id, text)

    def text(self, run, item_id, text):
        if run["cancelled"]:
            return
        fields = {"item_id": item_id, "kind": "assistant_text", "phase": "final"}
        if item_id not in run["text_items"]:
            run["text_items"].append(item_id)
            self.emit({"type": "item", "run_id": run["id"], **fields, "status": "started"})
        run["text"].append(text)
        self.emit({"type": "text_delta", "run_id": run["id"], **fields, "status": "delta", "text": text})

    def complete(self, run, item_id):
        if item_id in run["text_items"] and item_id not in run["completed"] and not run["cancelled"]:
            run["completed"].add(item_id)
            self.emit({"type": "item", "run_id": run["id"], "item_id": item_id, "kind": "assistant_text",
                       "phase": "final", "status": "completed"})

    def cli_exited(self, code):
        if self.shutdown or not self.ready_sent:
            return
        if self.active:
            done = self.active.get("done")
            if done and not done.done():
                done.set_exception(RunnerFailure(code))
            return
        self.emit({"type": "error", "code": code, "failure": classify_failure(code), "message": "Claude Code exited"})
        self._accept({"type": "close"})

    async def run(self, message):
        run = self.active
        run.update(text=[], text_items=[], completed=set(), errors=[], message=None,
                   done=asyncio.get_running_loop().create_future())
        prompt = message["prompt"]
        if isinstance(message.get("ask_user_result"), dict):
            prompt = ask_user_prompt(prompt, message["ask_user_result"])
        prompt = history_prompt(prompt, message.get("history"))
        try:
            if self.failure:
                raise RunnerFailure(self.failure)
            await self.client.write({"type": "user", "message": {"role": "user", "content": prompt},
                                     "parent_tool_use_id": None, "session_id": self.session_id or "default"})
            result = await run["done"]
            for item_id in run["text_items"]:
                self.complete(run, item_id)
            subtype = result.get("subtype") if isinstance(result.get("subtype"), str) else "failed"
            stop, terminal = result.get("stop_reason"), result.get("terminal_reason")
            status = result.get("api_error_status")
            success = result.get("is_error") is False and subtype == "success" and not run["cancelled"] and \
                stop != "refusal" and terminal in (None, "completed") and status is None
            total = result.get("total_cost_usd")
            cost = None
            if isinstance(total, (int, float)) and not isinstance(total, bool):
                cost, self.total_cost_usd = total - self.total_cost_usd, total
            # Every message streams as the final answer, so the reply is all of them; result.result is only the last.
            text = "".join(run["text"]) or (result["result"] if success and isinstance(result.get("result"), str) else "")
            errors = [*run["errors"], *(e for e in result.get("errors") or [] if isinstance(e, str))]
            if result.get("is_error") and isinstance(result.get("result"), str):
                errors.append(result["result"])
            outcome = "success" if success else "cancelled" if run["cancelled"] else \
                subtype if subtype != "success" else "failed"
            self.emit({"type": "result", "run_id": run["id"], "session_id": self.session_id, "model": self.model,
                       "success": success, "subtype": outcome, "text": text, "final_text": text,
                       "usage": result_usage(result.get("usage")), "total_cost_usd": total if cost is not None else None,
                       "cost_usd": cost, "cost_source": "sdk_estimate" if cost is not None else None,
                       "num_turns": result.get("num_turns") if isinstance(result.get("num_turns"), int) else None,
                       "model_usage": result.get("modelUsage") if isinstance(result.get("modelUsage"), dict) else {},
                       "stop_reason": stop if isinstance(stop, str) else None,
                       "failure": None if success or run["cancelled"] else classify_failure(
                           " ".join(v for v in (terminal, stop, subtype) if isinstance(v, str)), errors,
                           status if isinstance(status, int) else None),
                       "error": None if success else outcome})
        except asyncio.CancelledError:
            self.emit({"type": "result", "run_id": run["id"], "success": False, "subtype": "cancelled"})
        except Exception as error:
            code = str(error) if isinstance(error, RunnerFailure) else type(error).__name__
            self.emit({"type": "error", "run_id": run["id"], "code": code, "failure": classify_failure(code),
                       "message": "Claude Code character harness failed"})
            if self.client.closed or self.failure:
                self._accept({"type": "close"})
        finally:
            if self.active is run:
                self.active = None

    async def interrupt(self, run_id):
        if not self.active or self.active["id"] != run_id:
            return
        self.active["cancelled"] = True
        for pending_run, future in list(self.pending.values()):
            if pending_run == run_id and not future.done():
                future.cancel()
        for pending_run, future in list(self.permissions.values()):
            if pending_run == run_id and not future.done():
                future.set_result(None)
        # By the time the request fails, run_task may be the next run's.
        task = self.run_task
        try:
            await self.client.control({"subtype": "interrupt"}, timeout=2)
        except RunnerFailure:
            if task:
                task.cancel()

    async def main(self):
        try:
            await super().main()
        finally:
            if self.bridge:
                self.bridge.close()
            if self.workspace:
                shutil.rmtree(self.workspace, ignore_errors=True)


if __name__ == "__main__":
    try:
        asyncio.run(ClaudeRunner().main())
        sys.stdout.flush()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    # The stdin reader thread may still block in readline; interpreter shutdown would abort on its lock.
    os._exit(0)
