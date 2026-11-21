"""`agentic-complex install-mcp`: the agentic-complex MCP server's entry in one agent client's user settings.

Without --write it changes nothing: it prints the unified diff to stderr and a JSON summary to stdout.
Files and formats (checked 2026-11-21):
- claude: `claude mcp add-json --scope user` writes ~/.claude.json, https://code.claude.com/docs/en/mcp
- codex: [mcp_servers.<name>] in ~/.codex/config.toml, https://developers.openai.com/codex/mcp
- gemini: mcpServers in ~/.gemini/settings.json, https://geminicli.com/docs/tools/mcp-server/
- cursor: mcpServers in ~/.cursor/mcp.json, https://cursor.com/docs/mcp
"""
import difflib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

from fsutil import atomic_write_text

NAME = "agentic-complex"
CLIENTS = ("claude", "codex", "gemini", "cursor")
SCRIPT = str(Path(__file__).resolve().parent / "agentic_complex.py")


def add_parser(commands):
    sub = commands.add_parser("install-mcp", help="add this MCP server to one agent client's user settings")
    sub.add_argument("--client", choices=CLIENTS, required=True)
    sub.add_argument("--write", action="store_true", help="make the change; without it only show it")


def server(launcher, state_dir):
    """{command, args}: the launcher the shell writes (its .cmd through cmd /c), else this Python on this script."""
    if launcher is None:
        return {"command": sys.executable, "args": ["-I", SCRIPT, "--state-dir", str(state_dir), "mcp"]}
    if launcher.lower().endswith(".cmd"):
        return {"command": "cmd", "args": ["/c", launcher, "mcp"]}
    return {"command": launcher, "args": ["mcp"]}


def config_path(client):
    if client == "claude":
        return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home()) / ".claude.json"
    if client == "codex":
        return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    return Path.home() / {"gemini": ".gemini/settings.json", "cursor": ".cursor/mcp.json"}[client]


def toml_string(value):
    return json.dumps(value, ensure_ascii=False)  # a JSON string is a TOML basic string


def codex_text(old, entry):
    """config.toml with our [mcp_servers.agentic-complex] table (and its subtables) replaced or appended."""
    block = (f"[mcp_servers.{NAME}]\ncommand = {toml_string(entry['command'])}\n"
             f"args = [{', '.join(map(toml_string, entry['args']))}]\n")
    header = re.compile(rf"^\[\s*mcp_servers\.(?:{re.escape(NAME)}|\"{re.escape(NAME)}\")\s*(?:\]|\.)", re.M)
    found = header.search(old)
    if found is None:
        return old + ("\n" if old and not old.endswith("\n") else "") + ("\n" if old else "") + block
    rest = re.compile(r"^\[", re.M)
    end = found.end()
    while (following := rest.search(old, end)) is not None and header.match(old, following.start()):
        end = following.end()
    stop = following.start() if following else len(old)
    return old[:found.start()] + block + ("\n" if following else "") + old[stop:]


def json_text(old, entry):
    data = json.loads(old) if old.strip() else {}
    if not isinstance(data, dict) or not isinstance(data.setdefault("mcpServers", {}), dict):
        raise ValueError("mcpServers is not an object")
    data["mcpServers"][NAME] = entry
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def run(args):
    entry = server(args.launcher, args.state_dir)
    path = config_path(args.client)
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    summary = {"client": args.client, "file": str(path), "server": entry}
    try:
        if args.client == "claude":
            current = json.loads(old).get("mcpServers", {}).get(NAME) if old.strip() else None
            wanted = {"type": "stdio", **entry, "env": {}}
            before, after = json.dumps(current, indent=2) + "\n", json.dumps(wanted, indent=2) + "\n"
            commands = ([["claude", "mcp", "remove", "--scope", "user", NAME]] if current is not None else []) + \
                [["claude", "mcp", "add-json", "--scope", "user", NAME, json.dumps(wanted)]]
            summary["commands"] = commands
        else:
            if args.client == "codex":
                tomllib.loads(old)
                new = codex_text(old, entry)
                tomllib.loads(new)
            else:
                new = json_text(old, {"type": "stdio", **entry} if args.client == "cursor" else entry)
            before, after = old, new
    except (ValueError, tomllib.TOMLDecodeError) as error:
        print(json.dumps({**summary, "error": "unreadable_settings", "detail": str(error)}, ensure_ascii=False))
        return 1
    diff = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), str(path), str(path)))
    summary.update(changed=before != after, written=False)
    print(diff or f"{path}: no change\n", end="", file=sys.stderr)
    if args.write and summary["changed"]:
        if args.client == "claude":
            if shutil.which("claude") is None:
                print(json.dumps({**summary, "error": "claude_not_found"}, ensure_ascii=False))
                return 1
            for command in commands:
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(path, after, mode=path.stat().st_mode & 0o777 if path.exists() else None)
        summary["written"] = True
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0
