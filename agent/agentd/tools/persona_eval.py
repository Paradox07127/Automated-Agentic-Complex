#!/usr/bin/env python3
"""Persona drift eval: play fixed scripts to a real character through an in-process agentd, check every reply by rule
and by a Claude Haiku judge, and compare the first and last turns of each scenario.

usage: persona_eval.py --backend claude|codex --model haiku|gpt-6-luna [--scenarios chat,task] [--turns N] [--judge on|off]
                       [--budget-usd 2] [--character ID] [--character-catalog PATH] [--out DIR]"""
import argparse
import collections
import datetime
import http.client
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.markers import MarkerStream  # noqa: E402
from brain.persona import render_persona  # noqa: E402
from brain.voice_check import out_of_voice  # noqa: E402
from infra.paths import agentd_db  # noqa: E402

PORT = 48810
ROOT = Path(__file__).resolve().parents[3]
SCENARIOS = Path(__file__).with_name("persona_eval_scenarios.json")
CATALOG = ROOT / ".local/library/current.json"
SEGMENT = 10  # turns in the first and in the last segment of a scenario
OPENING = 6  # leading characters two replies in a row must not share
ASSISTANT_PHRASES = ("有什么可以帮你", "有什么我可以帮", "希望对你有帮助", "希望这对你有帮助", "如果你还有其他问题",
                     "如有其他问题", "随时告诉我", "很高兴为你服务",
                     "how can i help", "how can i assist", "i hope this helps", "let me know if you have any other",
                     "feel free to ask", "happy to help")
# Names of the model or its maker behind her, matched lowercased.
KERNEL_NAMES = ("claude", "codex", "gpt", "anthropic", "openai", "gemini", "deepseek", "大模型", "语言模型")
RULES = ("ai_self_reference", "markdown_layout", "assistant_phrase", "same_opening", "intent_marker", "kernel_name")
DIMENSIONS = ("voice", "canon", "no_assistant", "length")
JUDGE_MODEL = "haiku"
JUDGE_RUBRIC = ("你是角色扮演对话的评审。下面 <persona> 是一个桌面角色的设定，她和用户用中文聊天。"
                "你会看到最近两轮对话和她的最新一条回复（行首意图标记已去掉），只给最新这条回复打分，每项 1–5 分：\n"
                "- voice：口吻、用词、态度像设定里的她（5 完全是她，1 完全不像）。\n"
                "- canon：和设定的身份、经历、知识边界一致，没有编造设定外的事实，没有说出她不该知道的现实世界知识（5 完全一致，1 明显矛盾）。\n"
                "- no_assistant：没有 AI 助手腔，如自称 AI、客服套话、主动罗列服务、Markdown 排版（5 完全没有，1 很重）。\n"
                "- length：长度适合气泡里的一句口头回复和这句用户话（5 正合适，1 过长或过短）。\n"
                "reason 用一句中文说明最主要的扣分点，没有就说没有。\n\n")
JUDGE_SCHEMA = {"type": "object", "additionalProperties": False, "required": [*DIMENSIONS, "reason"],
                "properties": {**{d: {"type": "integer", "minimum": 1, "maximum": 5} for d in DIMENSIONS},
                               "reason": {"type": "string"}}}
# The workspace's files before the task scenario starts; its script reads them by these names.
WORKSPACE_FILES = {"weekly-report.md": "# 周报草稿\n\n- 本周完成：整理仓库盘点表\n- 进行中：新人培训材料\n- 下周：交季度预算初稿\n"}
_INTENT = re.compile(r"\s*\[intent:[^\]\n]*\]")


def shown(raw):
    """raw with its markers removed, as the speech bubble shows it."""
    stream = MarkerStream()
    text = stream.feed(raw)[0] + stream.close()[0]
    return text.strip()


def intent_marker(raw):
    """"ok" when raw leads with an [intent:x] marker the parser passes, "invalid" for another intent value, else "missing"."""
    lead = _INTENT.match(raw)
    if lead is None:
        return "missing"
    return "ok" if MarkerStream().feed(lead.group(0))[1] else "invalid"


def rule_check(raw, previous=None):
    """The rule results of one reply: raw is the model's text with its markers, previous the reply before it as shown."""
    text = shown(raw)
    voice = out_of_voice(raw)
    lowered = text.lower()
    phrases = [p for p in ASSISTANT_PHRASES if p in lowered]
    same = bool(previous) and bool(text) and text[:OPENING] == previous[:OPENING]
    intent = intent_marker(raw)
    names = [n for n in KERNEL_NAMES if n in lowered]
    violations = [r for r, hit in zip(RULES, ("ai_self_reference" in voice, "markdown_layout" in voice, bool(phrases),
                                               same, intent != "ok", bool(names))) if hit]
    return {"out_of_voice": voice, "chars": len(text), "markdown": "markdown_layout" in voice,
            "assistant_phrases": phrases, "same_opening": same,
            "opening": text[:OPENING], "intent_marker": intent, "kernel_names": names, "violations": violations}


def _segment(rows):
    if not rows:
        return None
    judged = [r["judge"] for r in rows if r.get("judge")]
    return {"turns": [rows[0]["turn"], rows[-1]["turn"]], "count": len(rows),
            "violation_rate": round(sum(bool(r["rules"]["violations"]) for r in rows) / len(rows), 3),
            "rule_rates": {rule: round(sum(rule in r["rules"]["violations"] for r in rows) / len(rows), 3) for rule in RULES},
            "judge_mean": {d: round(statistics.mean(j[d] for j in judged), 2) for d in DIMENSIONS} if judged else None,
            "judged": len(judged)}


def summarize(rows):
    """Per scenario, the rule violation rates and judge means of turns 1-10 and of the last 10 turns; total costs."""
    scenarios = {}
    for name in dict.fromkeys(r["scenario"] for r in rows):
        turns = sorted((r for r in rows if r["scenario"] == name and r["rules"] is not None), key=lambda r: r["turn"])
        scenarios[name] = {"turns": len(turns), "first": _segment([r for r in turns if r["turn"] <= SEGMENT]),
                           "last": _segment(turns[-SEGMENT:]),
                           "routes": dict(collections.Counter(r.get("route") for r in turns)),
                           "errors": sum(1 for r in rows if r["scenario"] == name and r.get("error"))}
    seconds = [r["seconds"] for r in rows if r.get("seconds") is not None]
    kernel = [r["kernel_cost_usd"] for r in rows if r.get("kernel_cost_usd") is not None]
    return {"scenarios": scenarios,
            "kernel_cost_usd": round(sum(kernel), 6) if kernel else None,
            "judge_cost_usd": round(sum(r.get("judge_cost_usd") or 0 for r in rows), 6),
            "mean_turn_seconds": round(statistics.mean(seconds), 2) if seconds else None, "rows": len(rows)}


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def judge(persona, history, user, reply, workdir):
    """Haiku's scores of one reply: (structured_output, total_cost_usd)."""
    context = "".join(f"用户：{h['user']}\n她：{h['reply']}\n" for h in history)
    prompt = f"<recent>\n{context}</recent>\n<latest>\n用户：{user}\n她：{reply}\n</latest>"
    command = ["claude", "-p", "--model", JUDGE_MODEL, "--system-prompt", JUDGE_RUBRIC + f"<persona>\n{persona}\n</persona>",
               "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
               "--output-format", "json", "--json-schema", json.dumps(JUDGE_SCHEMA), prompt]
    done = subprocess.run(command, cwd=workdir, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
    result = json.loads(done.stdout)
    return result.get("structured_output"), result.get("total_cost_usd")


class Agentd:
    """HTTP access to the in-process agentd: the feed and /say."""

    def __init__(self, base, token, state_dir, workspace):
        self.host, self.port = base.split("//")[1].split(":")
        self.token, self.db = token, agentd_db(state_dir)
        self.workspace = os.path.realpath(workspace)
        self.feed = None
        self.approvals = []  # the approval cards answered during the current line

    def request(self, method, path, body=None, timeout=60):
        conn = http.client.HTTPConnection(self.host, int(self.port), timeout=timeout)
        conn.request(method, path, body=None if body is None else json.dumps(body).encode(),
                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def open_feed(self):
        conn = http.client.HTTPConnection(self.host, int(self.port), timeout=600)
        conn.request("GET", "/feed", headers={"Authorization": f"Bearer {self.token}"})
        self.feed = conn.getresponse()

    def next_event(self):
        event = {}
        while True:
            line = self.feed.fp.readline().decode()
            if not line:
                raise ConnectionError("feed closed")
            if line.startswith(("id: ", "event: ", "data: ")):
                key, _, value = line.rstrip("\n").partition(": ")
                event[key] = value
            elif line == "\n" and "data" in event:
                return event

    def line(self, line_id):
        """(shown text, final event) of line_id once it is final."""
        text = []
        while True:
            event = self.next_event()
            if event.get("event") == "agent_interaction":
                data = json.loads(event["data"])
                if data.get("kind") == "approval" and data.get("state") == "pending":
                    self.approve(data["request_id"])
                continue
            if event.get("event") != "line":
                continue
            data = json.loads(event["data"])
            if data["line_id"] != line_id:
                continue
            text.append(data["text_delta"])
            if data["final"]:
                return "".join(text), data

    def approve(self, request_id):
        """Answer an approval card as the user would: allow edits of files inside the workspace, deny anything else."""
        _, listed = self.request("GET", "/agent/interactions")
        row = next((r for r in listed["requests"] if r["request_id"] == request_id), None)
        if row is None:
            return
        preview = row["data"].get("preview") or {}
        locations = preview.get("locations") or []
        allow = bool(locations) and all(os.path.realpath(p).startswith(self.workspace + os.sep) for p in locations)
        code, _ = self.request("POST", f"/agent/interactions/{request_id}/answer",
                               {"expected_version": row["revision"], "answers": {"decision": ["允许" if allow else "拒绝"]}})
        self.approvals.append({"title": preview.get("title"), "locations": locations,
                               "decision": "allow" if allow else "deny", "status": code})

    def query(self, sql, args=()):
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def kernel_cost(self):
        return self.query("SELECT COALESCE(SUM(cost_usd), 0) FROM model_usage")[0][0]

    def turn(self, line_id):
        rows = self.query("SELECT raw_reply, reply, state FROM history_turns WHERE turn_id=?", (line_id,))
        return rows[0] if rows else (None, None, None)


def port_listeners(port):
    done = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    return done.stdout.strip()


def run_eval(args, state_dir, out, persona, status):
    """The eval thread: waits for agentd, plays the scenarios, writes turns.jsonl and summary.json, then stops agentd."""
    try:
        runtime = Path(state_dir) / "ui-runtime.json"
        deadline = time.monotonic() + 120
        while not runtime.exists():
            if time.monotonic() > deadline or status.get("main_done"):
                raise RuntimeError("agentd did not start")
            time.sleep(0.2)
        values = json.loads(runtime.read_text(encoding="utf-8"))
        agent = Agentd(values["base_url"], values["ui_token"], state_dir, Path(state_dir) / "workspace")
        code, kernel = agent.request("GET", "/character/runtime?refresh=1", timeout=120)
        routes = {k: {"backend": v["backend"], "ready": v["ready"], "error": v["error"]} for k, v in kernel["routes"].items()}
        status["kernel"] = {"backend": kernel.get("backend"), "model": kernel.get("model"), "routes": routes}
        print(f"persona-eval: kernel {kernel.get('backend')} {kernel.get('model')}; chat ready={routes['chat']['ready']}, "
              f"quick ready={routes['quick']['ready']}", flush=True)
        if not routes["chat"]["ready"]:
            raise RuntimeError(f"chat route not ready: {routes['chat']['error']}")
        scripts = json.loads(SCENARIOS.read_text(encoding="utf-8"))
        agent.open_feed()
        rows, spent = [], 0.0
        judge_dir = tempfile.mkdtemp(prefix="judge-", dir=state_dir)
        with open(out / "turns.jsonl", "w", encoding="utf-8") as log:
            for name in args.scenarios:
                agent.request("POST", "/conversations", {"title": f"persona-eval {name}"})
                history = []
                for number, user in enumerate(scripts[name][:args.turns], 1):
                    if spent >= args.budget_usd:
                        status["stopped"] = f"budget reached at {name} turn {number}: {spent:.4f} USD"
                        break
                    before, started = agent.kernel_cost(), time.monotonic()
                    row = {"scenario": name, "turn": number, "user": user, "reply": None, "raw_reply": None,
                           "rules": None, "judge": None, "kernel_cost_usd": None, "judge_cost_usd": None,
                           "seconds": None, "route": None, "approvals": None, "error": None}
                    agent.approvals = []
                    code, said = agent.request("POST", "/say", {"text": user, "source": "text"})
                    if code != 202:
                        row["error"] = f"say {code}: {said}"
                    else:
                        row["route"] = said.get("runtime")
                        text, final = agent.line(said["line_id"])
                        row["seconds"] = round(time.monotonic() - started, 2)
                        raw, _, state = agent.turn(said["line_id"])
                        row.update(reply=text, raw_reply=raw, state=state, approvals=agent.approvals)
                        if final.get("error") or final.get("cancelled"):
                            row["error"] = f"line {final.get('error') or 'cancelled'}"
                        row["rules"] = rule_check(raw if raw is not None else text,
                                                  history[-1]["reply"] if history else None)
                    # Codex reports no USD cost, so --budget-usd bounds only the judge there.
                    row["kernel_cost_usd"] = None if args.backend == "codex" else round(agent.kernel_cost() - before, 6)
                    spent += row["kernel_cost_usd"] or 0
                    if args.judge == "on" and row["reply"] and spent < args.budget_usd:
                        try:
                            row["judge"], row["judge_cost_usd"] = judge(persona, history[-2:], user, row["reply"],
                                                                        judge_dir)
                        except (subprocess.SubprocessError, ValueError, OSError) as error:
                            row["error"] = (row["error"] or "") + f" judge {type(error).__name__}: {error}"
                        spent += row["judge_cost_usd"] or 0
                    rows.append(row)
                    history.append({"user": user, "reply": row["reply"] or ""})
                    log.write(json.dumps(row, ensure_ascii=False) + "\n")
                    log.flush()
                    scores = row["judge"] and " ".join(f"{d}={row['judge'][d]}" for d in DIMENSIONS)
                    print(f"persona-eval: {name} {number}: {row['seconds']}s violations="
                          f"{row['rules'] and row['rules']['violations']} judge={scores} spent={spent:.4f}"
                          + (f" error={row['error']}" if row["error"] else ""), flush=True)
                if "stopped" in status:
                    break
        summary = summarize(rows)
        # background calls included
        summary["kernel_cost_usd_total"] = None if args.backend == "codex" else round(agent.kernel_cost(), 6)
        summary.update(kernel=status["kernel"], stopped=status.get("stopped"), character=args.character,
                       scenarios_run=args.scenarios, turns=args.turns, judge=args.judge, budget_usd=args.budget_usd)
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        status["ok"] = True
    except Exception as error:  # the eval thread must still stop agentd
        status["error"] = f"{type(error).__name__}: {error}"
    finally:
        if not status.get("main_done"):
            os.kill(os.getpid(), signal.SIGTERM)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", required=True, choices=("claude", "codex"), help="the kernel under test")
    parser.add_argument("--model", required=True, help="kernel model; the judge is always JUDGE_MODEL")
    parser.add_argument("--scenarios", default="chat,task,venting,break_character,out_of_world")
    parser.add_argument("--turns", type=int, default=40, help="the first N lines of each scenario")
    parser.add_argument("--judge", choices=("on", "off"), default="on")
    parser.add_argument("--budget-usd", type=float, default=2.0, help="stop once kernel and judge spend reach it")
    parser.add_argument("--character", help="default: the catalog's default_character")
    parser.add_argument("--character-catalog", type=Path, default=CATALOG)
    parser.add_argument("--out", type=Path,
                        default=ROOT / ".local/output/persona-eval" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args(argv)
    args.scenarios = [s for s in args.scenarios.split(",") if s]
    known = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    if unknown := [s for s in args.scenarios if s not in known]:
        parser.error(f"--scenarios: unknown {', '.join(unknown)}")
    return args


def main():
    args = parse_args()
    if busy := port_listeners(PORT):
        sys.exit(f"persona-eval: port {PORT} is in use:\n{busy}")
    from brain import characters
    from character_agent.services.settings import RuntimeSettings
    repository = characters.Repository(args.character_catalog)
    args.character = args.character or repository.default()
    persona = render_persona(repository.load_card(args.character), language="zh-Hans")
    args.out.mkdir(parents=True, exist_ok=True)
    state_dir = tempfile.mkdtemp(prefix="persona-eval-")
    workspace = Path(state_dir) / "workspace"
    workspace.mkdir()
    for name, content in WORKSPACE_FILES.items():
        (workspace / name).write_text(content, encoding="utf-8")
    RuntimeSettings(state_dir).save({"backend": args.backend, "runtime_source": "local", "auth_source": "existing_login",
                                     "model": args.model, "reply_language": "zh-Hans",
                                     "max_budget_usd": min(args.budget_usd, 20), "workspace_dir": str(workspace)})
    print(f"persona-eval: character {args.character}; state {state_dir}; out {args.out}", flush=True)
    from daemon import main as agentd
    from infra.secrets import MemorySecrets
    sys.argv = ["agentd", "--port", str(PORT), "--state-dir", state_dir, "--character-catalog", str(args.character_catalog),
                "--character", args.character, "--no-proactive", "--mute", "--plugin-on", "harness_bridge",
                "--plugin-on", "personal_agent"]  # personal_agent: the reminder tools and the harness's own file tools
    status = {}
    worker = threading.Thread(target=run_eval, args=(args, state_dir, args.out, persona, status))
    worker.start()
    log = open(args.out / "agentd.log", "w", encoding="utf-8")
    sys.stderr = log
    try:
        agentd.main(secret_store=MemorySecrets())
    finally:
        status["main_done"] = True
        worker.join()
        sys.stderr = sys.__stderr__
        log.close()
    still = port_listeners(PORT)
    print(f"persona-eval: port {PORT} " + (f"still in use:\n{still}" if still else "released"), flush=True)
    if not status.get("ok"):
        sys.exit(f"persona-eval: failed: {status.get('error')}")
    if status.get("stopped"):
        print(f"persona-eval: stopped early: {status['stopped']}", flush=True)
    print(f"persona-eval: summary {args.out / 'summary.json'}", flush=True)


if __name__ == "__main__":
    main()
