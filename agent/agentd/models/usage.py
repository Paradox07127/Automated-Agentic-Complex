"""Each model call's tokens and cost, summed per local day, model and call in the shared store."""
import json
import threading
import time

from models.model_auth import ModelError

TOKENS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
UNFINISHED = ("incomplete", "failed", "cancelled")  # statuses counted beside calls; "completed" only adds a call
LONG_PROMPT = 100_000  # prompt tokens (input + cache writes + cache reads) above which the long-prompt rates apply
# USD per million tokens: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-19).
# (input, 5-minute cache write, 1-hour cache write, cache read, output) for short and long prompts.
PRICES = {
    "claude-haiku-5-5": {"short": (0.10, 0.125, 0.20, 0.01, 0.50), "long": (0.50, 0.625, 1.0, 0.05, 2.50)},
    "claude-sonnet-5-5": {"short": (2, 2.5, 4, 0.10, 10), "long": (2, 2.5, 4, 0.10, 10)},
}
BACKGROUND = ("judge", "behavior", "capture_judge", "memory_extract", "observation_interpret", "observation_vision", "proactive_decide", "review", "task_hypothesis", "facing_decide", "observation_brief", "worklog_fast", "worklog_deep", "repeat", "thought", "observation_summary")
HOUR_CAP = 12
DAY_CAP = 48
PURPOSE_CAPS = {"proactive_decide": 10, "memory_extract": 40, "task_hypothesis": 24,
                "observation_interpret": 240, "observation_vision": 20, "observation_brief": 3,
                "worklog_fast": 120, "worklog_deep": 38, "repeat": 1, "thought": 120,
                "observation_summary": 144}
# Hourly caps of purposes outside the shared HOUR_CAP pool; workers ending together would otherwise spend it.
OWN_HOUR_CAPS = {"observation_interpret": 30, "worklog_fast": 30, "repeat": 1, "thought": 30, "observation_summary": 12}
BACKGROUND_DAY_CAP = max(DAY_CAP, sum(PURPOSE_CAPS.get(purpose, DAY_CAP) for purpose in BACKGROUND))
# Admission ceilings on reported usage, including cache tokens. A running call
# can cross the ceiling; unavailable provider usage is never a zero-cost proof.
# Daily and weekly briefs share one purpose; measured runs on 11-02/03 used 12-23k
# tokens each, so this admits about seven a day with a weekly brief among them.
PURPOSE_TOKEN_CAPS = {'observation_brief': 160_000}


def _count(usage, name):
    value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
    if name == "cache_creation_input_tokens" and value is None:
        value = getattr(usage, "cache_creation", None)
    if isinstance(value, dict) and name == "cache_creation_input_tokens":
        value = sum(value.values()) if all(type(v) is int and v >= 0 for v in value.values()) else None
    return value if type(value) is int and value >= 0 else 0


def failure(error):
    """The status of a call that raised error: a reply that stopped short is incomplete, anything else failed."""
    return "incomplete" if isinstance(error, ModelError) and str(error) == "inference_not_completed" else "failed"


def cost(model, usage, at=None):
    """USD for one call, or None when the model has no price."""
    if model in ("deepseek-flash", "deepseek-v4-pro"):
        utc = time.gmtime(time.time() if at is None else at)
        peak = utc.tm_wday < 5 and (1 <= utc.tm_hour < 4 or 6 <= utc.tm_hour < 10)
        base, hit, out = (.15, .003, .60) if model == "deepseek-flash" else (.66, .022, 1.98)
        return (_count(usage, "input_tokens") * base + _count(usage, "cache_read_input_tokens") * hit
                + _count(usage, "output_tokens") * out) * (2 if peak else 1) / 1e6
    prices = PRICES.get(model)
    if prices is None:
        return None
    read, written = _count(usage, "cache_read_input_tokens"), _count(usage, "cache_creation_input_tokens")
    breakdown = getattr(usage, "cache_creation", None)
    if breakdown is not None:
        short_ttl = _count(breakdown, "ephemeral_5m_input_tokens")
        long_ttl = _count(breakdown, "ephemeral_1h_input_tokens")
    else:
        short_ttl, long_ttl = written, 0
    prompt = _count(usage, "input_tokens") + written + read
    base, write_5m, write_1h, hit, out = prices["long" if prompt > LONG_PROMPT else "short"]
    return (_count(usage, "input_tokens") * base + short_ttl * write_5m + long_ttl * write_1h + read * hit
            + _count(usage, "output_tokens") * out) / 1e6


class UsageMeter:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.Lock() if lock is None else lock
        with self.lock:
            self.db.execute("CREATE TABLE IF NOT EXISTS semantic_attempts (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL,"
                            " outcome TEXT NOT NULL, at REAL NOT NULL, day TEXT NOT NULL,"
                            " counted INTEGER NOT NULL, conversation INTEGER NOT NULL)")
            self.db.execute("CREATE INDEX IF NOT EXISTS semantic_attempts_window ON semantic_attempts(at)")
            self.db.execute("CREATE INDEX IF NOT EXISTS semantic_attempts_day ON semantic_attempts(day,purpose)")
            self.db.commit()

    def record(self, model, call, usage, status="completed", local=False, *, provider=None, channel=None, attempt_id=None,
               cost_usd=None, cost_source=None):
        """Add one call to the day's row and to its per-channel details."""
        model = getattr(usage, "model", model)
        provider = provider or getattr(usage, "provider", None) or "unknown"
        channel = channel or getattr(usage, "channel", None) or {"anthropic": "anthropic_api", "openai": "openai_api",
                              "chatgpt": "chatgpt_subscription",
                              "deepseek": "deepseek_api", "compatible": "compatible_api"}.get(provider, "unknown")
        values = [getattr(usage, name, None) for name in TOKENS]
        if values[1] is None:
            values[1] = getattr(usage, "cache_creation", None)
        if isinstance(values[1], dict):
            values[1] = sum(values[1].values()) if all(type(v) is int and v >= 0 for v in values[1].values()) else None
        tokens = [_count(usage, name) for name in TOKENS]
        missing = any(type(value) is not int or value < 0 for value in values)
        # Anthropic cache writes are charged differently by TTL. A missing or inconsistent
        # breakdown cannot safely be assumed to be the cheaper 5-minute cache.
        if not missing and provider == "anthropic" and channel == "anthropic_api" and tokens[1] > 0:
            breakdown = getattr(usage, "cache_creation", None)
            short = breakdown.get("ephemeral_5m_input_tokens") if isinstance(breakdown, dict) else getattr(breakdown, "ephemeral_5m_input_tokens", None)
            long = breakdown.get("ephemeral_1h_input_tokens") if isinstance(breakdown, dict) else getattr(breakdown, "ephemeral_1h_input_tokens", None)
            missing = type(short) is not int or type(long) is not int or short < 0 or long < 0 or short + long != tokens[1]
        ended = [int(status == name) for name in UNFINISHED]
        direct_pricing = not local and provider == "anthropic" and channel == "anthropic_api" and model in PRICES
        tier = getattr(usage, "service_tier", None)
        geo = getattr(usage, "inference_geo", None)
        speed = getattr(usage, "speed", None)
        # These are response facts, not assumed request defaults. Priority uses committed
        # capacity; batch/fast have other rates, and workspace defaults may override geo.
        factors_known = tier == "standard" and speed == "standard" and geo in ("global", "us")
        pricing_unverified = int(direct_pricing and not missing and not factors_known)
        price = cost(model, usage) if direct_pricing and not missing and factors_known else None
        if not local and provider == "deepseek" and channel == "deepseek_api" and not missing:
            price = cost(model, usage, self.clock())
        if price is not None and direct_pricing and geo == "us":
            price *= 1.1
        if cost_source == "sdk_estimate" and cost_usd is not None:
            price = cost_usd
        unpriced = int(not local and price is None)
        day = self._day()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                existing = self.db.execute("SELECT channel_json FROM model_usage WHERE day = ? AND model = ? AND call = ?",
                                           (day, model, call)).fetchone()
                details = self._details(existing[0] if existing else "{}")
                # Both components are controlled identifiers; JSON keys retain the provider even where
                # the same routing channel can contain models from different underlying providers.
                key = json.dumps([provider, channel, bool(local), 2], separators=(",", ":"))
                item = details.setdefault(key, self._zero())
                if cost_source == "sdk_estimate" and cost_usd is not None:
                    item["cost_source"] = cost_source
                item["calls"] += 1
                for name, value in zip((*TOKENS, "cost_usd", *UNFINISHED, "usage_missing", "unpriced", "pricing_unverified"),
                                       (*tokens, price if price is not None else 0.0, *ended, int(missing), unpriced, pricing_unverified)):
                    item[name] += value
                item["local"] += int(local)
                self.db.execute(
                    f"INSERT INTO model_usage (day, model, call, calls, {', '.join(TOKENS)}, cost_usd, {', '.join(UNFINISHED)},"
                    " local, channel_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) "
                    "ON CONFLICT(day, model, call) DO UPDATE SET calls = calls + 1, local = 0, channel_json = excluded.channel_json, "
                    + ", ".join(f"{name} = {name} + excluded.{name}" for name in (*TOKENS, "cost_usd", *UNFINISHED)),
                    (day, model, call, *tokens, price if price is not None else 0.0, *ended,
                     json.dumps(details, separators=(",", ":"))))
                if call in BACKGROUND and not local and attempt_id is None:
                    self.db.execute("INSERT INTO semantic_attempts(purpose,outcome,at,day,counted,conversation) VALUES(?,?,?,?,1,0)",
                                    (call, "succeeded" if status == "completed" else status, self.clock(), day))
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    @staticmethod
    def _details(raw):
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                return {}
            return {k: v for k, v in data.items() if isinstance(v, dict)}
        except (TypeError, ValueError):
            return {}

    def _admit(self, call, conversation):
        if call not in BACKGROUND:
            return True
        if PURPOSE_CAPS.get(call) == 0:
            return False
        if call in PURPOSE_TOKEN_CAPS:
            spent = self.db.execute('SELECT COALESCE(SUM(input_tokens+cache_creation_input_tokens+cache_read_input_tokens+output_tokens),0) FROM model_usage WHERE day=? AND call=?', (self._day(),call)).fetchone()[0]
            if spent >= PURPOSE_TOKEN_CAPS[call]: return False
        pool = (call,) if call in OWN_HOUR_CAPS else tuple(OWN_HOUR_CAPS)
        hour = self.db.execute("SELECT COUNT(*) FROM semantic_attempts WHERE at>? AND counted=1 AND purpose "+
            ("IN" if call in OWN_HOUR_CAPS else "NOT IN")+" ("+",".join("?"*len(pool))+")",
            (self.clock()-3600,*pool)).fetchone()[0]
        if hour >= OWN_HOUR_CAPS.get(call, HOUR_CAP):
            return False
        day = self._day()
        attempts = dict(self.db.execute("SELECT purpose,COUNT(*) FROM semantic_attempts WHERE day=? AND counted=1 GROUP BY purpose", (day,)))
        counted = {purpose:attempts.get(purpose,0) for purpose in BACKGROUND}
        if sum(counted.values()) >= BACKGROUND_DAY_CAP: return False
        return counted[call] < PURPOSE_CAPS.get(call,DAY_CAP)

    def admit(self, call, *, conversation=False):
        with self.lock:
            return self._admit(call,conversation)

    def attempt(self, call, outcome, *, conversation=False):
        """Atomically reserve admission and record a content-free attempt."""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                if outcome == "admitted" and not self._admit(call,conversation):
                    outcome = "usage_cap"
                counted = int(outcome == "admitted" and call in BACKGROUND)
                ident = self.db.execute("INSERT INTO semantic_attempts(purpose,outcome,at,day,counted,conversation)"
                                        " VALUES(?,?,?,?,?,?)", (call,outcome,self.clock(),self._day(),counted,int(conversation))).lastrowid
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        return ident,outcome

    def finish_attempt(self, ident, outcome, *, counted):
        with self.lock:
            self.db.execute("UPDATE semantic_attempts SET outcome=?,counted=counted AND ? WHERE id=?", (outcome,int(counted),ident))
            self.db.commit()

    def today(self):
        """Today's calls in total, by call and by channel."""
        with self.lock:
            rows = self.db.execute("SELECT call, channel_json FROM model_usage WHERE day = ? ORDER BY id",
                                   (self._day(),)).fetchall()
        total, by_call, by_channel = self._zero(), {}, {}
        for call, raw_json in rows:
            for key, item in self._details(raw_json).items():
                channel = json.loads(key)[1]
                for row in (total, by_call.setdefault(call, self._zero()), by_channel.setdefault(channel, self._zero())):
                    for name in row:
                        row[name] += item[name]
        return {**total, "by_call": by_call, "by_channel": by_channel}

    def _day(self):
        return time.strftime("%Y-%m-%d", time.localtime(self.clock()))

    @staticmethod
    def _zero():
        return {"calls": 0, **{name: 0 for name in TOKENS}, "cost_usd": 0, "unpriced": 0,
                **{name: 0 for name in UNFINISHED}, "local": 0, "usage_missing": 0, "pricing_unverified": 0}
