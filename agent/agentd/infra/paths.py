"""agentd's state-file names, the default state directories, and the roots outside it that agentd reads.

codex_hook_forward.py runs inside user hooks on its own and keeps its own copies."""
import os
from pathlib import Path

# Each entry point keeps its own state-dir default.
STATE_DIR_DEFAULT = "agentd-state"  # server.py --state-dir, relative to the working directory
APP_STATE_DIR = "~/Library/Application Support/AgenticComplex/agentd"  # tools/install_hooks.py --token-file
COMPANION_BUNDLE = "local.agenticcomplex.companion"
COMPANION_WINDOWS_APP_ID = "agentic complex.exe"  # the Windows helper's app_id of the packaged exe
AGENTD_PORT = 48800
COMPANION_SUPPORT_DIR = Path.home() / "Library/Application Support" / COMPANION_BUNDLE  # Mac TTS reads it too

HOOK_TOKEN = "hook.token"
AGENTD_DB = "agentd.sqlite"
ATTENTION_DB = "attention.sqlite"
TIMELINE_DB = "timeline.sqlite"
BLACKLIST = "blacklist.json"
PROACTIVE_JUDGE_LOG = "proactive-judge.jsonl"
UI_RUNTIME = "ui-runtime.json"
EVENTS_RUNTIME = "events-runtime.json"
INTEGRATION_RUNTIME = "integration-runtime.json"
MODEL_SETTINGS = "model-settings.json"
CHARACTER_RUNTIME = "character-runtime.json"
FOCUS = "focus.json"
SPATIAL = "spatial.json"
TTS_TOKEN = "tts-token"

TTS_TOKEN_FILE = (Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming") / "Agentic Complex"
                  if os.name == "nt" else COMPANION_SUPPORT_DIR) / TTS_TOKEN

LEDGER_ROOT = os.path.expanduser("~/.claude/harness/events")
CLAUDE_SETTINGS = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude", "settings.json")
CODEX_HOME = "~/.codex"
CODEX_HOOKS = "hooks.json"  # in CODEX_HOME


def hook_token(state_dir): return Path(state_dir) / HOOK_TOKEN
def agentd_db(state_dir): return Path(state_dir) / AGENTD_DB
def attention_db(state_dir): return Path(state_dir) / ATTENTION_DB
def timeline_db(state_dir): return Path(state_dir) / TIMELINE_DB
def blacklist(state_dir): return Path(state_dir) / BLACKLIST
def proactive_judge_log(state_dir): return Path(state_dir) / PROACTIVE_JUDGE_LOG
def ui_runtime(state_dir): return Path(state_dir) / UI_RUNTIME
def events_runtime(state_dir): return Path(state_dir) / EVENTS_RUNTIME
def integration_runtime(state_dir): return Path(state_dir) / INTEGRATION_RUNTIME
def model_settings(state_dir): return Path(state_dir) / MODEL_SETTINGS
def character_runtime(state_dir): return Path(state_dir) / CHARACTER_RUNTIME
def focus(state_dir): return Path(state_dir) / FOCUS
def spatial(state_dir): return Path(state_dir) / SPATIAL


def app_state_dir():
    """The shell's default agentd state dir: APP_STATE_DIR on macOS, %LOCALAPPDATA%\\Agentic Complex\\agentd on Windows."""
    if os.name != "nt":
        return Path(APP_STATE_DIR).expanduser()
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Agentic Complex" / "agentd"
