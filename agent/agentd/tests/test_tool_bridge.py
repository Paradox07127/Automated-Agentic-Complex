"""tool_bridge over infra.platform's private IPC endpoint: a unix socket on POSIX, a named pipe on Windows."""
import asyncio
import ctypes
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
import unittest

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))
from character_agent.harness.tool_bridge import BRIDGE, BridgeServer, Upstream  # noqa: E402
from infra.platform import connect_ipc, serve_ipc  # noqa: E402

TOOLS = [{"name": "fixture_read", "description": "Read a fixture", "inputSchema": {"type": "object"}}]


def endpoint_exists(endpoint):
    """A unix socket's private directory, or a named pipe listed under \\\\.\\pipe\\."""
    if sys.platform == "win32":
        return Path(endpoint).name in os.listdir("\\\\.\\pipe\\")
    return Path(endpoint).parent.is_dir()


def pipe_dacl(handle):
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    dacl, descriptor, text = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_wchar_p()
    # SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION
    advapi32.GetSecurityInfo.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p,
                                         ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    error = advapi32.GetSecurityInfo(handle, 6, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if error:
        raise ctypes.WinError(error)
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p]
    if not advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, ctypes.byref(text), None):
        raise ctypes.WinError(ctypes.get_last_error())
    return text.value


class IpcTests(unittest.TestCase):
    def test_lines_cross_both_ways_while_a_read_waits(self):
        async def echo(reader, writer):
            while line := await reader.readline():
                writer.write(b"> " + line)
                await writer.drain()
            writer.close()

        def client(address):
            connection = connect_ipc(address)
            try:
                got = []
                reader = threading.Thread(target=lambda: got.extend(connection.readline(1 << 20) for _ in range(2)))
                reader.start()
                # The read is already blocked when the writes go out; a half-duplex handle would hang here.
                time.sleep(0.2)
                connection.write("héllo\n".encode())
                connection.write(b"two\n")
                reader.join(5)
                return got
            finally:
                connection.close()

        async def main():
            server, address = await serve_ipc(echo, "eftest-")
            try:
                return await asyncio.wait_for(asyncio.to_thread(client, address), 10)
            finally:
                server.close()

        self.assertEqual(asyncio.run(main()), ["> héllo\n".encode(), b"> two\n"])

    def test_endpoint_is_private_and_gone_after_close(self):
        async def ignore(reader, writer):
            writer.close()

        async def main():
            server, address = await serve_ipc(ignore, "eftest-")
            try:
                self.assertTrue(endpoint_exists(address))
                if sys.platform == "win32":
                    from infra.platform.windows import _user_sid
                    self.assertTrue(address.startswith("\\\\.\\pipe\\eftest-"), address)
                    self.assertEqual(pipe_dacl(server._pipe.handle), f"D:P(A;;FA;;;{_user_sid()})")
                else:
                    # A short base keeps the path under the unix socket limit.
                    self.assertEqual(Path(address).parent.parent, Path("/tmp"))
                    self.assertTrue(Path(address).parent.name.startswith("eftest-"))
                    self.assertEqual(stat.S_IMODE(Path(address).parent.stat().st_mode), 0o700)
            finally:
                server.close()
            return address

        self.assertFalse(endpoint_exists(asyncio.run(main())))


class BridgeTests(unittest.TestCase):
    def run_bridge(self, client, call=None):
        """Starts a BridgeServer, runs client(server) in a thread and returns what it returns."""
        async def answer(name, arguments):
            return {"content": [{"type": "text", "text": f"{name}:{json.dumps(arguments)}"}]}

        async def main():
            server = BridgeServer(TOOLS, call or answer)
            await server.start("eftest-")
            try:
                return await asyncio.wait_for(asyncio.to_thread(client, server), 20)
            finally:
                server.close()

        return asyncio.run(main())

    def test_wrong_token_is_refused_and_the_right_one_gets_the_tools(self):
        def client(server):
            with self.assertRaises(PermissionError):
                Upstream(server.address, "wrong")
            return Upstream(server.address, server.token).tools

        self.assertEqual(self.run_bridge(client), TOOLS)

    def test_concurrent_calls_are_answered_by_id(self):
        first_waiting, release = asyncio.Event(), None

        async def call(name, arguments):
            nonlocal release
            if arguments["n"] == 1:
                release = asyncio.Event()
                first_waiting.set()
                await release.wait()
            else:
                await first_waiting.wait()
                release.set()
            return {"content": [{"type": "text", "text": str(arguments["n"])}]}

        def client(server):
            upstream = Upstream(server.address, server.token)
            results = {}
            threads = [threading.Thread(target=lambda n=n: results.update({n: upstream.call("fixture_read", {"n": n})}))
                       for n in (1, 2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
            return results

        results = self.run_bridge(client, call)
        self.assertEqual({n: r["content"][0]["text"] for n, r in results.items()}, {1: "1", 2: "2"})

    def test_stdio_mcp_process_lists_and_calls_the_runner_tools(self):
        def client(server):
            command, args = server.command()
            self.assertEqual((command, args[:5]), (sys.executable, ["-I", "-B", "-X", "utf8", str(BRIDGE)]))
            mcp = b"".join(json.dumps(m).encode() + b"\n" for m in (
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "fixture_read",
                                                                                "arguments": {"path": "ü"}}}))
            proc = subprocess.Popen([command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE)
            proc.stdin.write(mcp)
            proc.stdin.flush()
            replies = {}
            while len(replies) < 3:
                message = json.loads(proc.stdout.readline())
                replies[message["id"]] = message["result"]
            proc.stdin.close()
            proc.wait(10)
            return replies

        replies = self.run_bridge(client)
        self.assertEqual(replies[1]["serverInfo"]["name"], "agentic_complex")
        self.assertEqual(replies[2]["tools"], TOOLS)
        self.assertEqual(replies[3]["content"], [{"type": "text", "text": 'fixture_read:{"path": "\\u00fc"}'}])


if __name__ == "__main__":
    unittest.main()
