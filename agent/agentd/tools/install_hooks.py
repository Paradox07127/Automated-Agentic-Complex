#!/usr/bin/env python3
"""Add observe-only agentd hooks to the user-level Claude Code settings and Codex hooks.json, or take them out.

Only the hook groups this tool owns are added, replaced or removed; everything else in the files stays.
Every hook runs in the background (`async`), so the agent never waits for it.
It never touches Codex's config.toml or hook trust.
"""
import argparse
import copy
import difflib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fsutil import atomic_write_json  # noqa: E402
from infra.paths import AGENTD_PORT, APP_STATE_DIR, CLAUDE_SETTINGS, CODEX_HOME, CODEX_HOOKS, hook_token  # noqa: E402

EXAMPLES = Path(__file__).resolve().parents[1] / "config-examples"
FORWARDER = str(Path(__file__).resolve().parents[1] / "codex_hook_forward.py")
TOKEN = str(hook_token(APP_STATE_DIR))
HTTP_TIMEOUT = "0.8"
HOOK_TIMEOUT = 2
TRUST_NOTE = ("codex: open codex once and choose Review hooks, or run /hooks, to trust them; "
              "until then Codex skips them")
WINDOWS = sys.platform == "win32"
PS_QUOTES = "'‘’‚‛"  # PowerShell ends a single-quoted string at any of these


class Refused(Exception):
    """A file this tool will not change; then it writes nothing at all."""


def default_token_file():
    """agentd's hook.token in the shell's default state dir, on Windows %LOCALAPPDATA%\\Agentic Complex\\agentd."""
    if not WINDOWS:
        return TOKEN
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return str(hook_token(os.path.join(local, "Agentic Complex", "agentd")))


def example_events(name):
    """{event: its matcher or None} from the first group of each event in an example file."""
    hooks = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))["hooks"]
    return {event: groups[0].get("matcher") for event, groups in hooks.items()}


def hook_script_name():
    return "agentic-complex-hook.cmd" if WINDOWS else "agentic-complex-hook"


def powershell_quote(s):
    return "'" + re.sub(f"([{PS_QUOTES}])", r"\1\1", s) + "'"


def hook_entry(args, endpoint):
    """The hook in the shell its CLI runs it with: sh -c on macOS. On Windows Codex runs %COMSPEC% /C "<command>";
    Claude Code runs Git Bash or, without it, PowerShell, so our entry pins PowerShell, where no MSYS path
    conversion rewrites /hook/claude."""
    powershell = WINDOWS and endpoint == "/hook/claude"
    quote = powershell_quote if powershell else (lambda s: f'"{s}"') if WINDOWS else shlex.quote
    program = [args.hook_script] if args.hook_script else [args.python, args.forwarder]
    words = [*map(quote, program), "--endpoint", endpoint, "--observe", "--timeout", HTTP_TIMEOUT,
             "--url", quote(args.url), "--token-file", quote(args.token_file)]
    if powershell:
        hook = {"type": "command", "command": " ".join(["&", *words]), "shell": "powershell"}
    else:
        hook = {"type": "command", "command": " ".join(words)}
    # In the background, and for Claude Code the action goes on when the hook fails; Codex documents no onFailure.
    extra = {"onFailure": "continue"} if endpoint == "/hook/claude" else {}
    return {**hook, "async": True, **extra, "timeout": HOOK_TIMEOUT}


def windows_words(command):
    """The words of a command hook_entry writes on Windows: "…" for cmd, '…' with doubled quotes for PowerShell."""
    words = []
    for m in re.finditer(f"""[{PS_QUOTES}]((?:[^{PS_QUOTES}]|[{PS_QUOTES}]{{2}})*)[{PS_QUOTES}]|"([^"]*)"|(\\S+)""",
                         command):
        single, double, bare = m.groups()
        words.append(re.sub(f"([{PS_QUOTES}])[{PS_QUOTES}]", r"\1", single) if single is not None
                     else double if double is not None else bare)
    return words


def is_ours(group, url):
    """The group's single hook runs the forwarder, or the Companion's agentic-complex-hook script that runs it,
    with --observe against this agentd URL; on Windows paths in either separator and any case."""
    hooks = group.get("hooks") if isinstance(group, dict) else None
    if not isinstance(hooks, list) or len(hooks) != 1 or not isinstance(hooks[0], dict):
        return False
    command = hooks[0].get("command")
    if hooks[0].get("type") != "command" or not isinstance(command, str):
        return False
    if WINDOWS:
        words = windows_words(command)
        paths = [word.replace("\\", "/").casefold() for word in words]
        program = paths[1:2] if paths[:1] == ["&"] else paths[:1]
    else:
        try:
            words = shlex.split(command)
        except ValueError:
            return False
        paths, program = words, words[:1]
    forwards = any(path.endswith("/codex_hook_forward.py") for path in paths) or (
        bool(program) and program[0].endswith("/bin/" + hook_script_name()))
    return (forwards and "--observe" in words
            and ["--url", url] in [words[i:i + 2] for i in range(len(words) - 1)])


def load(path):
    """The file's JSON object, or None when the file is missing."""
    try:
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
    except FileNotFoundError:
        return None
    except ValueError as e:
        raise Refused(f"{path}: not valid JSON ({e})")
    if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
        raise Refused(f"{path}: expected an object with a \"hooks\" object")
    return data


def install(data, events, hook, url, path):
    """Our group, with the event's matcher, on each of events, replacing ours in place; ours on other events go."""
    uninstall(data, url, keep=events)
    hooks = data.setdefault("hooks", {})
    for event, matcher in events.items():
        group = {"matcher": matcher, "hooks": [hook]} if matcher else {"hooks": [hook]}
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise Refused(f"{path}: hooks.{event} is not a list")
        mine = [i for i, g in enumerate(groups) if is_ours(g, url)]
        if not mine:
            groups.append(group)
            continue
        groups[mine[0]] = group
        for i in reversed(mine[1:]):
            del groups[i]


def uninstall(data, url, keep=()):
    """Removes our groups on the events not in keep, then event lists and a hooks object that only became
    empty by that."""
    hooks, removed = data.get("hooks") or {}, False
    for event, groups in list(hooks.items()):
        if not isinstance(groups, list) or event in keep:
            continue
        kept = [g for g in groups if not is_ours(g, url)]
        if len(kept) == len(groups):
            continue
        removed = True
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if removed and not hooks:
        del data["hooks"]


def owned(data, url):
    hooks = (data or {}).get("hooks") or {}
    return {event: mine for event, groups in hooks.items() if isinstance(groups, list)
            for mine in [[g for g in groups if is_ours(g, url)]] if mine}


def report(path, before, after, url):
    """Unified diff of only our groups, then `+ <event>` / `- <event>` for each event they change."""
    old, new = owned(before, url), owned(after, url)
    lines = list(difflib.unified_diff(json.dumps(old, indent=2).splitlines(), json.dumps(new, indent=2).splitlines(),
                                      str(path), str(path), lineterm=""))
    for event in [*old, *(e for e in new if e not in old)]:
        if event not in new:
            lines.append(f"- {event}")
        elif new[event] != old.get(event):
            lines.append(f"+ {event}")
    print("\n".join(lines) if lines else f"{path}: no change")



def write(path, data):
    """Replace path at once (temp file + rename) keeping its mode; a missing file is created 0600."""
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    atomic_write_json(path, data, mode, newline=True, indent=2)


def disconnect(path, url):
    """Remove only this service's observe-only hooks.

    The UI supplies only a tool name; the server owns this path. A symlink stays a symlink.
    Return a count of removed groups, never the file's other settings.
    """
    path = Path(path).expanduser().resolve()
    original = path.read_bytes() if path.exists() else None
    before = load(path)
    after = copy.deepcopy(before or {})
    count = sum(map(len, owned(before, url).values()))
    if not count:
        return {"removed": 0}
    uninstall(after, url)
    # Refuse to overwrite settings another application edited during preparation.
    if path.read_bytes() != original:
        raise Refused("hook settings changed; retry after refreshing")
    if not after and path.name == "hooks.json":
        path.unlink()
    else:
        write(path, after)
    return {"removed": count}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--claude-settings", default=CLAUDE_SETTINGS)
    parser.add_argument("--codex-home", default=CODEX_HOME)
    parser.add_argument("--url", default=f"http://127.0.0.1:{AGENTD_PORT}")
    parser.add_argument("--token-file", default=default_token_file())
    parser.add_argument("--python", default="/usr/bin/python3")
    parser.add_argument("--forwarder", default=FORWARDER)
    parser.add_argument("--hook-script", help="the hook runs this agentic-complex-hook (.cmd on Windows) in place of "
                                              "--python and --forwarder")
    parser.add_argument("--target", choices=("both", "claude", "codex"), default="both")
    parser.add_argument("--dry-run", action="store_true", help="print what would change, write nothing")
    parser.add_argument("--uninstall", action="store_true", help="remove the hooks this tool added")
    args = parser.parse_args(argv)
    # Hooks run in the agent's working directory.
    args.token_file = os.path.abspath(os.path.expanduser(args.token_file))
    args.forwarder = os.path.abspath(os.path.expanduser(args.forwarder))
    if Path(args.forwarder).name != "codex_hook_forward.py":
        parser.error("--forwarder must be a codex_hook_forward.py; ownership is recognised by that name")
    if args.hook_script:
        args.hook_script = os.path.abspath(os.path.expanduser(args.hook_script))
        name = Path(args.hook_script).name
        if (name.casefold() if WINDOWS else name) != hook_script_name():
            parser.error(f"--hook-script must be an {hook_script_name()}; ownership is recognised by that name")

    targets = (("claude", args.claude_settings, "/hook/claude", "claude-settings.agentd.json"),
               ("codex", os.path.join(args.codex_home, CODEX_HOOKS), "/hook/codex", "codex-hooks.agentd.json"))
    plans = []
    try:
        for name, path, endpoint, example in targets:
            if args.target not in ("both", name):
                continue
            # A symlinked file (dotfiles) is written where it points, so the link stays.
            path = Path(os.path.realpath(os.path.expanduser(path)))
            if not path.parent.is_dir():
                print(f"{path}: {path.parent} does not exist, skipped")
                continue
            before = load(path)
            after = copy.deepcopy(before or {})
            if args.uninstall:
                uninstall(after, args.url)
            else:
                install(after, example_events(example), hook_entry(args, endpoint), args.url, path)
            plans.append((name, path, before, after))
    except Refused as e:
        print(f"{e}; nothing changed", file=sys.stderr)
        return 2

    for name, path, before, after in plans:
        report(path, before, after, args.url)
        if args.dry_run or after == (before or {}):
            continue
        if name == "codex" and not after:
            path.unlink()
            print(f"removed {path}")
        else:
            write(path, after)
            print(f"wrote {path}")
    if args.dry_run:
        print("dry run: nothing written")
    elif not args.uninstall and any(name == "codex" for name, *_ in plans):
        print(TRUST_NOTE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
