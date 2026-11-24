#!/usr/bin/env python3
"""How a runner's Endfield tools reach an agent CLI: a stdio MCP server the CLI launches calls back into the runner.

Runner side, BridgeServer: listens on infra.platform's private IPC endpoint (a unix socket, a named pipe on Windows).
A connection's first line must carry the per-process token; a wrong one is answered {"ok": false} and closed, the
right one gets the tool list. After that each {"id", "name", "arguments"} line gets its {"id", "result"} when the
runner's call returns, in any order.
MCP side, this file run as a script: stdout is MCP JSON-RPC only. The runner owns the tool list and every result;
a connection whose token the runner rejects ends this process before any MCP reply.
"""
import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets
import sys
import threading

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from infra.platform import connect_ipc, serve_ipc

BRIDGE = Path(__file__).resolve()
MAX_FRAME = 40 * 1024 * 1024


class BridgeServer:
    """Serves tools (MCP definitions) to the bridge process; call(name, arguments) is awaited for each tools/call."""

    def __init__(self, tools, call):
        self.tools, self.call = tools, call
        self.token = secrets.token_hex(32)
        self.server = self.address = None

    async def start(self, prefix):
        self.server, self.address = await serve_ipc(self.connection, prefix, limit=MAX_FRAME)

    def command(self):
        """The MCP server's command and arguments, for the agent to launch."""
        return sys.executable, ["-I", "-B", "-X", "utf8", str(BRIDGE), "--endpoint", self.address, "--token", self.token]

    def close(self):
        if self.server:
            self.server.close()

    async def connection(self, reader, writer):
        lock = asyncio.Lock()
        tasks = set()

        async def reply(message):
            async with lock:
                writer.write(json.dumps(message, ensure_ascii=False, allow_nan=False).encode() + b"\n")
                await writer.drain()

        async def call(request):
            try:
                result = await self.call(request.get("name"), request.get("arguments"))
                await reply({"id": request.get("id"), "result": result})
            except Exception:
                try:
                    await reply({"id": request.get("id"), "result": error_result("tool_failed")})
                except Exception:
                    # Without a reply the bridge's call would wait forever; the closed connection ends it.
                    writer.close()

        try:
            hello = json.loads(await reader.readline())
            token = hello.get("token") if isinstance(hello, dict) else None
            if not isinstance(token, str) or not hmac.compare_digest(token.encode(), self.token.encode()):
                await reply({"ok": False})
                return
            await reply({"ok": True, "tools": self.tools})
            while True:
                line = await reader.readline()
                if not line:
                    break
                request = json.loads(line)
                if isinstance(request, dict):
                    task = asyncio.create_task(call(request))
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
        except (ValueError, OSError):
            pass
        finally:
            for task in list(tasks):
                task.cancel()
            writer.close()


class Upstream:
    """One authenticated connection to the runner; calls are multiplexed by id."""

    def __init__(self, address, token):
        self.connection = connect_ipc(address)
        self.write_lock = threading.Lock()
        self.send({"token": token})
        line = self.connection.readline(MAX_FRAME + 1)
        reply = json.loads(line) if line.endswith(b"\n") else {}
        if not isinstance(reply, dict) or reply.get("ok") is not True or not isinstance(reply.get("tools"), list):
            raise PermissionError("token rejected")
        self.tools = reply["tools"]
        self.lock = threading.Lock()
        self.waiting = {}
        self.next_id = 0
        self.closed = False
        threading.Thread(target=self.read, daemon=True).start()

    def send(self, message):
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        with self.write_lock:
            self.connection.write(raw)

    def read(self):
        try:
            while True:
                line = self.connection.readline(MAX_FRAME + 1)
                if not line or not line.endswith(b"\n"):
                    break
                message = json.loads(line)
                with self.lock:
                    slot = self.waiting.get(message.get("id"))
                if slot:
                    slot[1].append(message.get("result"))
                    slot[0].set()
        except (OSError, ValueError, AttributeError):
            pass
        finally:
            with self.lock:
                self.closed = True
                slots = list(self.waiting.values())
            for event, _ in slots:
                event.set()

    def call(self, name, arguments):
        event, box = threading.Event(), []
        with self.lock:
            if self.closed:
                return error_result("endfield_runner_unavailable")
            self.next_id += 1
            call_id = self.next_id
            self.waiting[call_id] = (event, box)
        try:
            self.send({"id": call_id, "name": name, "arguments": arguments})
            event.wait()
        except OSError:
            pass
        finally:
            with self.lock:
                self.waiting.pop(call_id, None)
        result = box[0] if box else None
        return result if isinstance(result, dict) else error_result("endfield_runner_unavailable")


def error_result(text):
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def serve(upstream, source, output):
    output_lock = threading.Lock()

    def reply(message):
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n"
        with output_lock:
            output.write(raw)
            output.flush()

    def call(request_id, name, arguments):
        reply({"jsonrpc": "2.0", "id": request_id, "result": upstream.call(name, arguments)})

    while True:
        line = source.readline(MAX_FRAME + 1)
        if not line:
            return
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            return
        request_id = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                raise ValueError("invalid request")
            request_id, method = message.get("id"), message.get("method")
            if request_id is None:
                continue
            params = message.get("params") or {}
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "agentic_complex", "version": "1"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": upstream.tools}
            elif method == "tools/call":
                threading.Thread(target=call, args=(request_id, params.get("name"), params.get("arguments", {})),
                                 daemon=True).start()
                continue
            else:
                reply({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
                continue
            reply({"jsonrpc": "2.0", "id": request_id, "result": result})
        except (ValueError, TypeError, AttributeError):
            reply({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid request"}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    # The agent starts this in the runner's workspace; as a working directory it would keep Windows from removing it.
    os.chdir(BRIDGE.parent)
    try:
        upstream = Upstream(args.endpoint, args.token)
    except (OSError, ValueError) as error:
        print(f"MCP bridge refused: {error}", file=sys.stderr)
        sys.exit(1)
    serve(upstream, sys.stdin.buffer, sys.stdout)


if __name__ == "__main__":
    main()
