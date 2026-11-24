"""Dangerous approvals:judged from the tool and its command or path, for the card's style
and the server's single-approval rule. Text inside quotes is an argument, except the string a shell runs with -c
or that eval runs, which is judged as a command."""
import os
import posixpath
import re
import shlex

from tool_gateway.protected_paths import SECRET_PARTS

COMMAND_TOOLS = {"Bash", "command", "commandExecution", "shell"}
FILE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit", "fileChange"}
PUNCTUATION = "();<>|&\n"
SEPARATING = set(";|&()\n")  # a run of punctuation with one of these ends the command before it
WRAPPERS = {"command", "env", "nohup", "time", "exec", "xargs", "caffeinate", "timeout", "nice"}
# options of each wrapper that take the next word as their value; every wrapper's options are skipped
WRAPPER_VALUED = {"env": {"-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"},
                  "timeout": {"-s", "--signal", "-k", "--kill-after"}, "nice": {"-n", "--adjustment"},
                  "caffeinate": {"-t", "-w"}, "exec": {"-a"},
                  "xargs": {"-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-J", "-L", "--max-lines", "-n",
                            "--max-args", "-P", "--max-procs", "-R", "-S", "-s", "--max-chars"}}
FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
CHECKOUT_BRANCH = {"-b", "-B", "--orphan"}  # checkout options that create a branch rather than overwrite paths
SHELL_VALUED = {"-o", "+o", "-O", "+O"}  # shell options that take the next word as their value
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SHELLS = {"sh", "bash", "zsh", "dash", "fish"}
FETCHERS = {"curl", "wget"}
# git options before the subcommand that take the next word as their value
GIT_VALUED = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"}
SYSTEM_DIRS = ("/etc/", "/system/", "/usr/", "/bin/", "/sbin/", "/library/", "/private/etc/")  # casefolded
RC_FILES = {".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"}


def classify(tool_name, summary):
    """{"dangerous", "rule"}; rule names the first rule that matched, None when none did."""
    rule = None
    if isinstance(summary, str) and summary:
        if tool_name in COMMAND_TOOLS:
            rule = _command(summary)
        elif tool_name in FILE_TOOLS:
            rule = _path(summary)
    return {"dangerous": rule is not None, "rule": rule}


def _segments(command):
    """(separator before it, words) for each simple command; None when shlex cannot split it."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=PUNCTUATION)
        lexer.whitespace = " \t\r"  # an unquoted newline ends a command, like ;
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:  # unbalanced quotes
        return None
    segments, words, before = [], [], None
    for token in tokens:
        if set(token) <= set(PUNCTUATION) and set(token) & SEPARATING:
            if before is not None and not words:  # `| \n` is one separator, as bash reads it
                before += token
                continue
            segments.append((before, words))
            words, before = [], token
        else:
            words.append(token)
    segments.append((before, words))
    return [(sep, words) for sep, words in segments if words]


def _command(command):
    segments = _segments(command)
    if segments is None:
        return "unparsable"
    fetched = False  # a fetcher ran earlier in this pipeline
    for separator, words in segments:
        piped = separator is not None and separator.replace("\n", "") in ("|", "|&")
        fetched = fetched and piped
        words = _unwrap(words)
        if not words:
            continue
        program = os.path.basename(words[0])
        inner = _inner(program, words[1:])
        rule = "sudo" if program in ("sudo", "doas") else _command(inner) if inner is not None \
            else _program(program, words[1:])
        if rule is None and piped and program in SHELLS and fetched:
            rule = "pipe_to_shell"
        if rule is not None:
            return rule
        fetched = fetched or program in FETCHERS
    return None


def _unwrap(words):
    while words and (ASSIGNMENT.match(words[0]) or words[0] in WRAPPERS):
        wrapper, words = words[0], words[1:]
        if wrapper in WRAPPERS:
            while words and words[0].startswith("-"):
                words = words[2:] if words[0] in WRAPPER_VALUED.get(wrapper, ()) else words[1:]
            if wrapper == "timeout":
                words = words[1:]  # the duration
    return words


def _inner(program, args):
    """The command string a shell runs with -c, or eval runs; None when there is none."""
    if program == "eval":
        return " ".join(args)
    if program in SHELLS:
        options, flags = 0, []
        while options < len(args) and (args[options].startswith("-") or args[options] in SHELL_VALUED):
            if args[options] in SHELL_VALUED:
                options += 2
                continue
            flags.append(args[options])
            options += 1
        if "c" in _short_flags(flags) and options < len(args):
            return args[options]
    return None


def _short_flags(args):
    return {c for a in args if a.startswith("-") and not a.startswith("--") for c in a[1:]}


def _program(program, args):
    flags, long = _short_flags(args), {a for a in args if a.startswith("--")}
    if program == "rm" and (flags & {"r", "R"} or "--recursive" in long) and ("f" in flags or "--force" in long):
        return "rm_recursive"
    if program == "git":
        while args and args[0].startswith("-"):
            args = args[2:] if args[0] in GIT_VALUED else args[1:]
        if args:
            return _git(args[0], args[1:])
    if program in ("chmod", "chown", "chgrp") and ("R" in flags or "--recursive" in long):
        return "recursive_permissions"
    if program == "dd" and any(a.startswith("of=/dev/") for a in args):
        return "disk"
    if program == "diskutil" and args and re.match(r"(?i)^(erase|zero|partition|secureErase)", args[0]):
        return "disk"
    if program.startswith("mkfs") or program == "newfs":
        return "disk"
    if program == "find" and ("-delete" in args or any(
            a in FIND_EXEC and os.path.basename(b) == "rm" for a, b in zip(args, args[1:]))):
        return "find_delete"
    return None


def _git(sub, args):
    flags, long = _short_flags(args), {a for a in args if a.startswith("--")}
    if sub == "push" and ("f" in flags or long & {"--force", "--mirror"}
                          or any(a.startswith(("--force-with-lease", "--force-if-includes")) for a in long)
                          or any(a.startswith("+") for a in args)):
        return "git_force_push"
    if sub == "reset" and "--hard" in long or sub == "clean" and ("f" in flags or "--force" in long):
        return "git_discard"
    if sub in ("checkout", "restore") and "--" in args or sub == "branch" and "D" in flags:
        return "git_discard"
    operands = [a for a in args if not a.startswith("-")]
    if sub == "restore" and operands:
        return "git_discard"
    # checkout overwrites paths when it names two operands (tree, path) or a path-looking one
    if sub == "checkout" and not CHECKOUT_BRANCH & set(args) and (len(operands) > 1 or any(
            a in (".", "..") or a.startswith(("./", "../", "/", ":")) or "*" in a for a in operands)):
        return "git_discard"
    return None


def _path(path):
    # both separators, no repeated slashes or dot segments, casefolded as on the default macOS and Windows volumes
    path = posixpath.normpath(re.sub(r"/+", "/", os.path.expanduser(path).replace("\\", "/"))).casefold()
    if path.startswith(SYSTEM_DIRS) or any(f"/{part.casefold()}/" in f"/{path}/" for part in SECRET_PARTS) \
            or posixpath.basename(path) in RC_FILES or "/.git/hooks/" in path or path.endswith("/.git/config"):
        return "sensitive_path"
    return None
