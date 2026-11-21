from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

MODEL = "claude-haiku-5-5"  # priced in models.usage.PRICES
from infra.store import open_store  # noqa: E402
from models.usage import DAY_CAP, HOUR_CAP, UsageMeter  # noqa: E402

NOON = time.mktime((2026, 10, 19, 12, 0, 0, 0, 0, -1))  # local noon: a day boundary is far either way
ZERO = {"calls": 0, "input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "output_tokens": 0, "cost_usd": 0, "unpriced": 0, "incomplete": 0, "failed": 0, "cancelled": 0, "local": 0,
        "usage_missing": 0, "pricing_unverified": 0, "by_call": {}, "by_channel": {}}


def usage(input_tokens=0, output_tokens=0, cache_creation_input_tokens=0, cache_read_input_tokens=0, split=None):
    """An SDK-shaped usage; split=(5m, 1h) adds the cache_creation breakdown."""
    split = (cache_creation_input_tokens, 0) if split is None else split
    breakdown = SimpleNamespace(ephemeral_5m_input_tokens=split[0], ephemeral_1h_input_tokens=split[1])
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens,
                           cache_creation_input_tokens=cache_creation_input_tokens,
                           cache_read_input_tokens=cache_read_input_tokens, cache_creation=breakdown, provider="anthropic",
                           service_tier="standard", inference_geo="global", speed="standard")


class UsageMeterTest(unittest.TestCase):
    def test_repeat_attempt_is_limited_to_one_per_local_day_across_restart(self):
        meter = self.meter()
        self.assertEqual(meter.attempt('repeat', 'admitted')[1], 'admitted')
        restarted = UsageMeter(meter.db, clock=lambda: self.now)
        self.assertEqual(restarted.attempt('repeat', 'admitted')[1], 'usage_cap')
        self.now += 86400
        self.assertEqual(restarted.attempt('repeat', 'admitted')[1], 'admitted')

    def test_memory_extraction_allows_forty_calls_with_or_without_conversation(self):
        meter = self.meter()
        for conversation in (False, True):
            with self.subTest(conversation=conversation):
                meter.db.execute('DELETE FROM semantic_attempts')
                meter.db.commit()
                self.now = time.mktime((2026, 11, 3, 0, 0, 0, 0, 0, -1))
                for i in range(40):
                    self.assertEqual(meter.attempt('memory_extract', 'admitted', conversation=conversation)[1], 'admitted', i)
                    self.now += 1200
                self.assertEqual(meter.attempt('memory_extract', 'admitted', conversation=conversation)[1], 'usage_cap')

    def test_report_over_48k_leaves_room_for_a_second_report(self):
        from models.usage import PURPOSE_TOKEN_CAPS
        meter = self.meter()
        # Daily and weekly reports share this purpose; include cache tokens.
        meter.record(MODEL, 'observation_brief', usage(10000, 5000, 10000, 35000))
        self.assertGreaterEqual(PURPOSE_TOKEN_CAPS['observation_brief'], 120000)
        self.assertTrue(meter.admit('observation_brief'))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = NOON

    def meter(self):
        db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        return UsageMeter(db, clock=lambda: self.now)

    def test_deepseek_prices_peak_off_peak_and_weekend(self):
        from datetime import datetime, timezone
        meter = self.meter()
        item = SimpleNamespace(input_tokens=1000000, output_tokens=1000000, cache_read_input_tokens=1000000,
                               cache_creation_input_tokens=0, provider='deepseek')
        for model, expected in (('deepseek-flash', .753), ('deepseek-v4-pro', 2.662)):
            for stamp, factor in (('2026-11-03T00:59:59', 1), ('2026-11-03T01:00:00', 2),
                                  ('2026-11-03T04:00:00', 1), ('2026-11-03T06:00:00', 2),
                                  ('2026-11-03T10:00:00', 1), ('2026-11-07T02:00:00', 1)):
                with self.subTest(model=model, stamp=stamp):
                    self.now = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc).timestamp()
                    before = meter.today()['cost_usd']
                    meter.record(model, 'judge', item)
                    self.assertAlmostEqual(meter.today()['cost_usd'] - before, expected * factor)
                    self.assertEqual(meter.today()['unpriced'], 0)

    def test_k03_dict_cache_creation_is_summed(self):
        meter = self.meter()
        item = usage(100, 10, 30)
        item.cache_creation_input_tokens = {'ephemeral_5m_input_tokens': 10, 'ephemeral_1h_input_tokens': 20}
        item.cache_creation = dict(item.cache_creation_input_tokens)
        meter.record(MODEL, 'mouth', item, provider='anthropic', channel='anthropic_api')
        today = meter.today()
        self.assertEqual(today['cache_creation_input_tokens'], 30)
        self.assertEqual(today['usage_missing'], 0)
        self.assertAlmostEqual(today['cost_usd'], .00002025)

    def test_k03_sdk_estimate_is_recorded_with_source(self):
        import json
        meter = self.meter()
        meter.record('sdk-model', 'character_agent', usage(100, 10, 30),
                     provider='deepseek', channel='pi_api_key',
                     cost_usd=.15, cost_source='sdk_estimate')
        today = meter.today()
        self.assertAlmostEqual(today['cost_usd'], .15)
        self.assertEqual((today['unpriced'], today['usage_missing']), (0, 0))
        details = json.loads(meter.db.execute('SELECT channel_json FROM model_usage').fetchone()[0])
        self.assertEqual(next(iter(details.values()))['cost_source'], 'sdk_estimate')

    def test_records_add_up_per_call(self):
        meter = self.meter()
        meter.record(MODEL, "judge", usage(1000, 500, 2000, 10000))
        meter.record(MODEL, "judge", usage(1000, 500, 2000, 10000))
        meter.record(MODEL, "mouth", None)
        today = meter.today()
        judge = {"calls": 2, "input_tokens": 2000, "cache_creation_input_tokens": 4000,
                 "cache_read_input_tokens": 20000, "output_tokens": 1000, "unpriced": 0,
                 "incomplete": 0, "failed": 0, "cancelled": 0, "local": 0,
                 "usage_missing": 0, "pricing_unverified": 0}
        self.assertAlmostEqual(today["by_call"]["judge"].pop("cost_usd"), 0.0014, places=12)
        self.assertEqual(today["by_call"]["judge"], judge)
        self.assertEqual(today["by_call"]["mouth"], {**judge, "calls": 1, "input_tokens": 0,
                                                     "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                                                     "output_tokens": 0, "cost_usd": 0, "unpriced": 1, "usage_missing": 1})
        self.assertEqual(today["calls"], 3)
        self.assertAlmostEqual(today["cost_usd"], 0.0014, places=12)

    def test_short_prompt_price(self):
        meter = self.meter()
        # prompt 1000 + 2000 + 10000 = 13,000 <= 100,000; no breakdown: all cache writes at the 5-minute rate
        # (1000 * 0.10 + 2000 * 0.125 + 10000 * 0.01 + 500 * 0.50) / 1e6 = (100 + 250 + 100 + 250) / 1e6
        meter.record(MODEL, "mouth", usage(1000, 500, 2000, 10000))
        self.assertAlmostEqual(meter.today()["cost_usd"], 0.0007, places=12)

    def test_prompt_of_exactly_100k_is_still_short(self):
        meter = self.meter()
        meter.record(MODEL, "mouth", usage(100000))  # 100000 * 0.10 / 1e6
        self.assertAlmostEqual(meter.today()["cost_usd"], 0.01, places=12)

    def test_long_prompt_price(self):
        meter = self.meter()
        # prompt 90000 + 20000 = 110,000 > 100,000
        # (90000 * 0.50 + 20000 * 0.05 + 1000 * 2.50) / 1e6 = (45000 + 1000 + 2500) / 1e6
        meter.record(MODEL, "mouth", usage(90000, 1000, 0, 20000))
        self.assertAlmostEqual(meter.today()["cost_usd"], 0.0485, places=12)

    def test_cache_writes_are_priced_by_ttl(self):
        meter = self.meter()
        # (100 * 0.10 + 1000 * 0.125 + 2000 * 0.20) / 1e6 = (10 + 125 + 400) / 1e6; all at 5m would be 385e-6
        meter.record(MODEL, "mouth", usage(100, 0, 3000, 0, split=(1000, 2000)))
        self.assertAlmostEqual(meter.today()["cost_usd"], 0.000535, places=12)
        # long prompt: (100 * 0.50 + 1000 * 0.625 + 199000 * 1) / 1e6 = (50 + 625 + 199000) / 1e6
        meter.record(MODEL, "mouth", usage(100, 0, 200000, 0, split=(1000, 199000)))
        self.assertAlmostEqual(meter.today()["cost_usd"], 0.000535 + 0.199675, places=12)

    def test_unknown_model_keeps_tokens_without_a_price(self):
        meter = self.meter()
        meter.record("claude-unknown-9", "eval", usage(100, 10))
        today = meter.today()
        self.assertEqual((today["calls"], today["input_tokens"], today["output_tokens"], today["cost_usd"],
                          today["unpriced"]), (1, 100, 10, 0, 1))
        self.assertEqual(today["by_call"]["eval"]["unpriced"], 1)

    def test_restart_keeps_the_day(self):
        meter = self.meter()
        meter.record(MODEL, "vision", usage(1000, 500, 2000, 10000))
        meter.record("claude-unknown-9", "eval", usage(100, 10))
        before = meter.today()
        self.assertEqual(before["calls"], 2)
        self.assertEqual(self.meter().today(), before)

    def test_next_day_starts_at_zero_and_keeps_yesterday(self):
        meter = self.meter()
        meter.record(MODEL, "behavior", usage(10, 5))
        self.now = NOON + 86400
        self.assertEqual(meter.today(), ZERO)
        rows = meter.db.execute("SELECT day, call, calls FROM model_usage").fetchall()
        self.assertEqual(rows, [("2026-10-19", "behavior", 1)])

    def test_every_ending_is_a_call_and_the_unfinished_ones_are_counted_apart(self):
        meter = self.meter()
        for status in ("completed", "incomplete", "failed", "cancelled"):
            meter.record(MODEL, "mouth", usage(10, 5), status)
        today = meter.today()
        self.assertEqual((today["calls"], today["incomplete"], today["failed"], today["cancelled"], today["local"]),
                         (4, 1, 1, 1, 0))
        self.assertEqual(today["by_call"]["mouth"]["failed"], 1)
        self.assertEqual(today["input_tokens"], 40)

    def test_local_calls_are_counted_but_not_unpriced(self):
        meter = self.meter()
        meter.record("elephant-1", "decision", None, local=True)
        meter.record("elephant-1", "decision", None, "failed", local=True)
        today = meter.today()
        self.assertEqual((today["calls"], today["local"], today["failed"], today["unpriced"]), (2, 2, 1, 0))
        self.assertEqual(today["by_call"]["decision"]["local"], 2)

    def test_same_model_channels_are_isolated_and_priced_only_for_anthropic_api(self):
        meter = self.meter()
        for provider in ("anthropic", "openai", "chatgpt", "compatible", "unknown"):
            meter.record(MODEL, "judge", usage(1000, 500), provider=provider)
        meter.record(MODEL, "judge", None, local=True)
        today = meter.today()
        self.assertEqual(today["calls"], 6)
        self.assertEqual(today["local"], 1)
        self.assertEqual(today["unpriced"], 4)
        self.assertAlmostEqual(today["cost_usd"], .00035)
        self.assertEqual(set(today["by_channel"]), {"anthropic_api", "openai_api", "chatgpt_subscription",
                                                    "compatible_api", "unknown"})
        self.assertEqual(today["by_channel"]["chatgpt_subscription"]["cost_usd"], 0)
        self.assertEqual(self.meter().today(), today)

    def test_missing_and_partial_usage_do_not_claim_price(self):
        meter = self.meter()
        partial = SimpleNamespace(input_tokens=10, output_tokens=None, cache_read_input_tokens=0,
                                  cache_creation_input_tokens=0, provider="anthropic")
        missing_cache = SimpleNamespace(input_tokens=10, output_tokens=1, cache_read_input_tokens=None,
                                        cache_creation_input_tokens=0, provider="anthropic")
        missing_ttl = SimpleNamespace(input_tokens=10, output_tokens=1, cache_read_input_tokens=0,
                                      cache_creation_input_tokens=5, provider="anthropic")
        for item in (None, partial, missing_cache, missing_ttl):
            meter.record(MODEL, "mouth", item, provider="anthropic")
        today = meter.today()
        self.assertEqual((today["usage_missing"], today["unpriced"], today["cost_usd"]), (4, 4, 0))
        self.assertEqual(today["input_tokens"], 30)

    def test_standard_geo_multiplier_and_unsupported_or_unknown_factors(self):
        meter = self.meter()
        regular = usage(1000, 500)
        us = usage(1000, 500)
        us.inference_geo = "us"
        meter.record(MODEL, "mouth", regular)
        meter.record(MODEL, "mouth", us)
        for field, value in (("service_tier", "priority"), ("service_tier", "batch"),
                             ("service_tier", None), ("inference_geo", None),
                             ("inference_geo", "eu"), ("speed", "fast"), ("speed", None)):
            item = usage(1000, 500)
            setattr(item, field, value)
            meter.record(MODEL, "mouth", item)
        today = meter.today()
        self.assertEqual((today["calls"], today["unpriced"], today["pricing_unverified"], today["usage_missing"]), (9, 7, 7, 0))
        self.assertAlmostEqual(today["cost_usd"], .00035 * 2.1)

    def test_budget_counts_attempts_not_usage_rows(self):
        meter = self.meter()
        meter.db.execute("INSERT INTO model_usage (day, model, call, calls, input_tokens, cache_creation_input_tokens, "
                         "cache_read_input_tokens, output_tokens, cost_usd, local) VALUES (?, ?, 'judge', ?, 0, 0, 0, 0, 0, 1)",
                         (meter._day(), MODEL, DAY_CAP))
        meter.db.commit()
        self.assertTrue(self.meter().admit("judge"))

    def test_anthropic_proxy_does_not_inherit_direct_api_price(self):
        meter = self.meter()
        meter.record(MODEL, "mouth", usage(1000, 500), provider="anthropic", channel="anthropic_other")
        result = meter.today()
        self.assertEqual((result["unpriced"], result["cost_usd"]), (1, 0))
        self.assertEqual(result["by_channel"]["anthropic_other"]["calls"], 1)

    def test_concurrent_connections_do_not_drop_channel_details(self):
        from concurrent.futures import ThreadPoolExecutor
        first, second = self.meter(), self.meter()
        def record(meter, provider):
            for _ in range(20):
                meter.record(MODEL, "mouth", usage(1, 1), provider=provider)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(record, first, "anthropic"), pool.submit(record, second, "chatgpt")]
            for future in futures:
                future.result()
        today = first.today()
        self.assertEqual(today["calls"], 40)
        self.assertEqual(today["by_channel"]["anthropic_api"]["calls"], 20)
        self.assertEqual(today["by_channel"]["chatgpt_subscription"]["calls"], 20)

    def test_background_calls_stop_at_the_hourly_cap_for_an_hour(self):
        meter = self.meter()
        for _ in range(HOUR_CAP - 1):
            meter.record(MODEL, "judge", None)
        self.assertTrue(meter.admit("judge"))
        self.assertTrue(meter.admit("judge"))  # admitting spends nothing
        meter.record(MODEL, "capture_judge", None, "failed")
        for call in ("judge", "behavior", "capture_judge"):
            self.assertFalse(meter.admit(call))
        for call in ("mouth", "vision"):
            self.assertTrue(meter.admit(call))
        self.now += 61 * 60
        self.assertTrue(meter.admit("judge"))

    def test_observation_interpretation_stops_at_30_an_hour_and_240_a_day(self):
        meter = self.meter()
        self.now = time.mktime((2026, 11, 3, 9, 0, 0, 0, 0, -1))
        for _ in range(30):
            self.assertEqual(meter.attempt("observation_interpret", "admitted")[1], "admitted")
        self.assertEqual(meter.attempt("observation_interpret", "admitted")[1], "usage_cap")
        self.assertTrue(meter.admit("judge"))
        for _ in range(7):
            self.now += 61 * 60
            for _ in range(30):
                meter.attempt("observation_interpret", "admitted")
        self.now += 61 * 60
        self.assertEqual(meter.attempt("observation_interpret", "admitted")[1], "usage_cap")

    def test_session_summaries_stop_at_120_a_day_in_their_own_hourly_pool(self):
        meter = self.meter()
        self.now = time.mktime((2026, 11, 3, 9, 0, 0, 0, 0, -1))
        for _ in range(HOUR_CAP):
            meter.record(MODEL, "judge", None)
        self.assertTrue(meter.admit("worklog_fast"))  # the shared pool's hour is spent, this one's is not
        for _ in range(30):
            self.assertEqual(meter.attempt("worklog_fast", "admitted")[1], "admitted")
        self.assertEqual(meter.attempt("worklog_fast", "admitted")[1], "usage_cap")
        self.now += 61 * 60
        for i in range(90):
            self.assertEqual(meter.attempt("worklog_fast", "admitted")[1], "admitted", i)
            self.now += 150
        self.assertEqual(meter.attempt("worklog_fast", "admitted")[1], "usage_cap")
        for purpose, cap in (("worklog_deep", 38),):
            for _ in range(cap):
                self.assertEqual(meter.attempt(purpose, "admitted")[1], "admitted", purpose)
                self.now += 600
            self.assertEqual(meter.attempt(purpose, "admitted")[1], "usage_cap", purpose)

    def test_ten_minute_summaries_stop_at_12_an_hour_in_their_own_pool_and_144_a_day(self):
        meter = self.meter()
        self.now = time.mktime((2026, 11, 3, 9, 0, 0, 0, 0, -1))
        for i in range(12):
            self.assertEqual(meter.attempt("observation_summary", "admitted")[1], "admitted", i)
        self.assertFalse(meter.admit("observation_summary"))
        self.assertTrue(meter.admit("memory_extract"))  # the shared pool's hour is untouched
        for _ in range(11):
            self.now += 61 * 60
            for i in range(12):
                self.assertEqual(meter.attempt("observation_summary", "admitted")[1], "admitted", i)
        self.now += 61 * 60
        self.assertFalse(meter.admit("observation_summary"))  # 144 today

    def test_thoughts_stop_at_30_an_hour_in_their_own_pool(self):
        meter = self.meter()
        self.now = time.mktime((2026, 11, 3, 9, 0, 0, 0, 0, -1))
        for i in range(30):
            self.assertEqual(meter.attempt("thought", "admitted")[1], "admitted", i)
        self.assertFalse(meter.admit("thought"))
        self.assertTrue(meter.admit("memory_extract"))  # the shared pool's hour is untouched
        self.now += 61 * 60
        self.assertTrue(meter.admit("thought"))

    def test_a_users_look_is_admitted_after_the_background_caps_are_spent(self):
        meter = self.meter()
        self.now = time.mktime((2026, 11, 3, 0, 0, 0, 0, 0, -1))
        for i in range(20):
            self.assertEqual(meter.attempt("observation_vision", "admitted")[1], "admitted", i)
            self.now += 1200
        self.assertEqual(meter.attempt("observation_vision", "admitted")[1], "usage_cap")
        for _ in range(HOUR_CAP):
            meter.record(MODEL, "judge", None)
        self.assertFalse(meter.admit("observation_vision"))
        self.assertEqual(meter.attempt("user_vision", "admitted")[1], "admitted")
        self.assertEqual(meter.db.execute("SELECT counted FROM semantic_attempts WHERE purpose='user_vision'").fetchall(),
                         [(0,)])

    def test_sonnet_has_one_price_over_its_whole_context(self):
        from models.usage import cost
        self.assertAlmostEqual(cost("claude-sonnet-5-5", usage(1_000_000, 100_000)), 3.0)
        self.assertAlmostEqual(cost("claude-sonnet-5-5", usage(100_000, 0, 0, 1_000_000)), 0.3)

    def test_local_calls_do_not_spend_the_paid_caps(self):
        meter = self.meter()
        for _ in range(HOUR_CAP):
            meter.record("elephant-1", "judge", None, local=True)
        self.assertTrue(meter.admit("judge"))

    def test_background_calls_stop_at_the_daily_cap_until_local_midnight(self):
        meter = self.meter()
        self.now = time.mktime((2026, 10, 19, 9, 0, 0, 0, 0, -1))
        for _ in range(DAY_CAP):
            meter.record(MODEL, "behavior", None)
            self.now += 10 * 60  # six an hour: the hourly cap never binds
        self.assertTrue(meter.admit("mouth"))
        self.assertFalse(meter.admit("behavior"))
        self.assertFalse(self.meter().admit("behavior"))  # the day's count survives a restart
        self.now = time.mktime((2026, 10, 20, 0, 5, 0, 0, 0, -1))
        self.assertTrue(meter.admit("behavior"))


if __name__ == "__main__":
    unittest.main()
