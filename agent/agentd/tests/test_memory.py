import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from personal.memory import COLUMNS, REINFORCE_HALF_LIFE, SELECT_CHARS, Memory, mentions  # noqa: E402
from infra.store import open_store  # noqa: E402
from api.memory import MemoryMixin  # noqa: E402
from test_c6_fixtures import FIXTURES, mismatches  # noqa: E402


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.path = Path(self.tmp.name) / "agentd.db"
        self.db = open_store(self.path)
        self.now = 1000.0
        self.memory = Memory(self.db, clock=self.tick)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def tick(self):
        self.now += 1
        return self.now

    @unittest.skipIf(sys.platform == "win32", "the test uses a file name character Windows forbids")
    def test_memory_response_pins_active_and_candidate_items(self):
        self.memory.add("回答先给结论", "confirmed_by_user")
        self.memory.add("周报按项目分组", "inferred_hypothesis", state="candidate")
        answers = []
        handler = SimpleNamespace(server=SimpleNamespace(memory=self.memory), _json=lambda *args: answers.append(args))
        MemoryMixin._memory_read(handler, "/memory")
        status, body = answers[0]
        self.assertEqual(status, 200)
        fixture = json.loads((FIXTURES / "memory.json").read_text(encoding="utf-8"))
        loose = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
        for row, state in zip(body["facts"], ("active", "candidate")):
            with self.subTest(state=state):
                self.assertEqual(mismatches(fixture["facts"][0], row,
                                            [p.removeprefix("facts[].") for p in loose["nullable"]["memory.json"]], []), [])
                self.assertEqual(row["state"], state)

    def rows(self, fact_id=None):
        where, args = ("", ()) if fact_id is None else (" WHERE fact_id = ?", (fact_id,))
        return self.db.execute(f"SELECT version, text, source, state FROM facts{where} ORDER BY id", args).fetchall()

    def test_sources_split_by_trust(self):
        said = self.memory.add("我在上海工作", "asserted_by_user", evidence=["ev-1"], occurred_at=900.0)
        page = self.memory.add("网页说猫比狗好", "observed_context", evidence=["obs-1"])
        guess = self.memory.add("可能喜欢猫", "inferred_hypothesis", kind="preference")
        self.assertIsInstance(said, str)
        self.assertEqual(str(uuid.UUID(said)), said)
        layers = self.memory.injectable()
        self.assertEqual([f["fact_id"] for f in layers["trusted"]], [said])
        self.assertEqual([f["fact_id"] for f in layers["low_trust"]], [page, guess])
        self.assertEqual(layers["trusted"][0], {
            "fact_id": said, "version": 1, "owner": None, "kind": "fact", "text": "我在上海工作", "source": "asserted_by_user",
            "evidence": ["ev-1"], "occurred_at": 900.0, "recorded_at": 1001.0, "last_used_at": None, "stale": False,
            "score": 0.0, "locked": False, "quiet": False})

    def test_page_opinion_is_not_a_preference_and_names_need_confirmation(self):
        with self.assertRaises(ValueError):
            self.memory.add("喜欢猫", "observed_context", kind="preference")
        for kind in ("name", "birthday"):
            for source in ("asserted_by_user", "observed_context", "inferred_hypothesis"):
                with self.assertRaises(ValueError):
                    self.memory.add("小林", source, kind=kind)
        self.assertEqual(self.rows(), [])
        self.memory.add("小林", "confirmed_by_user", kind="name")
        self.memory.add("3月1日", "confirmed_by_user", kind="birthday")
        self.assertEqual([f["kind"] for f in self.memory.injectable()["trusted"]], ["name", "birthday"])

    def test_rejects_blank_text_and_unknown_source_or_kind(self):
        for args in (("  ", "asserted_by_user"), ("", "asserted_by_user"), ("a", "character_said"),
                     ("a", "asserted_by_user", "mood")):
            with self.assertRaises(ValueError):
                self.memory.add(*args)
        self.assertEqual((self.rows(), self.memory.revision), ([], 0))
        fact = self.memory.add("我在上海", "asserted_by_user")
        with self.assertRaises(ValueError):
            self.memory.correct(fact, "  ")
        self.assertEqual([f["text"] for f in self.memory.active()], ["我在上海"])

    def test_pause_skips_new_facts_but_not_manual_ones(self):
        self.memory.set_paused(True)
        self.assertTrue(self.memory.paused())
        self.assertIsNone(self.memory.add("我在上海", "asserted_by_user"))
        self.assertEqual(self.rows(), [])
        manual = self.memory.add("我在北京", "asserted_by_user", manual=True)
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [manual])
        self.assertEqual(self.memory.clear(), 1)
        self.assertTrue(self.memory.paused())
        self.db.close()
        self.db = open_store(self.path)
        self.assertTrue(Memory(self.db).paused())
        Memory(self.db).set_paused(False)
        self.assertFalse(Memory(self.db).paused())

    def test_saying_a_fact_again_reinforces_it_and_the_score_halves_every_half_life(self):
        fact = self.memory.add("我养了一只猫", "asserted_by_user")
        self.assertIsNone(self.memory.reinforce("我养了两只猫"))
        self.assertIsNone(self.memory.reinforce("我养了一只猫", kind="preference"))
        self.assertEqual(self.memory.reinforce("我养了一只猫"), fact)
        self.assertEqual(self.memory.reinforce("我养了一只猫"), fact)
        self.assertEqual(len(self.rows()), 1)
        self.now += REINFORCE_HALF_LIFE - 1  # the next clock read is one half-life after the last reinforcement
        [active] = self.memory.active()
        self.assertAlmostEqual(active["score"], 1.0)
        self.assertEqual(self.memory.reinforce("我养了一只猫"), fact)
        self.now += 2 * REINFORCE_HALF_LIFE - 1
        self.assertAlmostEqual(self.memory.active()[0]["score"], 0.75)

    def test_a_high_score_never_confirms_a_fact(self):
        page = self.memory.add("在看猫的网页", "observed_context")
        for _ in range(5):
            self.assertEqual(self.memory.reinforce("在看猫的网页", source="observed_context"), page)
        [fact] = self.memory.active()
        self.assertEqual((fact["source"], round(fact["score"], 3)), ("observed_context", 5.0))
        self.assertEqual(self.memory.injectable()["trusted"], [])

    def test_confirming_keeps_the_score_and_correcting_resets_it(self):
        fact = self.memory.add("我在上海", "asserted_by_user")
        self.memory.reinforce("我在上海")
        self.memory.confirm(fact)
        self.assertAlmostEqual(self.memory.active()[0]["score"], 1.0, places=3)
        self.memory.correct(fact, "我在杭州")
        self.assertEqual(self.memory.active()[0]["score"], 0.0)

    def test_pause_skips_reinforcing_but_not_manual_reinforcing(self):
        fact = self.memory.add("我在上海", "asserted_by_user")
        self.memory.set_paused(True)
        self.assertIsNone(self.memory.reinforce("我在上海"))
        self.assertEqual(self.memory.active()[0]["score"], 0.0)
        self.assertEqual(self.memory.reinforce("我在上海", manual=True), fact)
        self.assertAlmostEqual(self.memory.active()[0]["score"], 1.0, places=3)

    def test_correct_writes_a_new_version(self):
        fact = self.memory.add("我住在上海", "asserted_by_user")
        self.assertEqual(self.memory.correct(fact, "我住在杭州"), 2)
        self.assertEqual(self.rows(fact), [(1, "我住在上海", "asserted_by_user", "corrected"),
                                           (2, "我住在杭州", "asserted_by_user", "active")])
        self.assertEqual([(f["version"], f["text"]) for f in self.memory.active()], [(2, "我住在杭州")])
        self.assertEqual(self.memory.correct(fact, "我住在苏州"), 3)
        self.assertEqual([f["text"] for f in self.memory.active()], ["我住在苏州"])

    def test_correcting_or_confirming_a_guess_makes_it_confirmed(self):
        guess = self.memory.add("可能喜欢猫", "inferred_hypothesis", kind="preference", evidence=["ev-2"],
                                occurred_at=950.0)
        page = self.memory.add("在看猫的网页", "observed_context")
        self.memory.correct(guess, "喜欢狗")
        self.assertEqual(self.memory.confirm(page), 2)
        self.assertEqual(self.rows(page), [(1, "在看猫的网页", "observed_context", "corrected"),
                                           (2, "在看猫的网页", "confirmed_by_user", "active")])
        trusted = self.memory.injectable()["trusted"]
        self.assertEqual([(f["fact_id"], f["text"], f["source"]) for f in trusted],
                         [(guess, "喜欢狗", "confirmed_by_user"), (page, "在看猫的网页", "confirmed_by_user")])
        self.assertEqual((trusted[0]["kind"], trusted[0]["evidence"], trusted[0]["occurred_at"]),
                         ("preference", ["ev-2"], 950.0))
        self.assertEqual(self.memory.injectable()["low_trust"], [])

    def test_delete_drops_text_of_every_version(self):
        fact = self.memory.add("我们约好周五打球", "asserted_by_user", kind="agreement")
        self.memory.correct(fact, "我们约好周六打球")
        self.memory.delete(fact)
        self.assertEqual(self.rows(fact), [(1, None, "asserted_by_user", "deleted"),
                                           (2, None, "asserted_by_user", "deleted")])
        self.assertEqual(self.memory.active(), [])
        for edit in (lambda: self.memory.correct(fact, "x"), lambda: self.memory.confirm(fact),
                     lambda: self.memory.delete("missing"), lambda: self.memory.correct("missing", "x")):
            with self.assertRaises(KeyError):
                edit()

    def test_revision_counts_successful_writes(self):
        self.assertEqual(self.memory.revision, 0)
        fact = self.memory.add("我在上海", "inferred_hypothesis")
        self.assertEqual(self.memory.revision, 1)
        self.memory.correct(fact, "我在杭州")
        self.assertEqual(self.memory.revision, 2)
        other = self.memory.add("在看网页", "observed_context")
        self.memory.confirm(other)
        self.assertEqual(self.memory.revision, 4)
        self.memory.delete(fact)
        self.assertEqual(self.memory.revision, 5)
        self.memory.set_paused(True)
        self.memory.add("不记", "asserted_by_user")
        self.assertEqual(self.memory.revision, 5)
        with self.assertRaises(KeyError):
            self.memory.delete(fact + "x")
        self.assertEqual(self.memory.revision, 5)
        self.memory.clear()
        self.assertEqual(self.memory.revision, 6)

    def test_export_holds_only_active_versions(self):
        kept = self.memory.add("一起看过烟花", "asserted_by_user", kind="experience")
        gone = self.memory.add("我在上海", "asserted_by_user")
        self.memory.correct(kept, "一起看过流星")
        self.memory.delete(gone)
        exported = self.memory.export()
        self.assertEqual([(f["fact_id"], f["version"], f["text"]) for f in exported], [(kept, 2, "一起看过流星")])
        self.assertEqual(exported, self.memory.active())

    def test_clear_removes_every_row(self):
        fact = self.memory.add("一", "asserted_by_user")
        self.memory.correct(fact, "二")
        self.memory.add("三", "observed_context")
        self.assertEqual(self.memory.clear(), 3)
        self.assertEqual((self.rows(), self.memory.active()), ([], []))

    def test_touch_marks_use_without_a_revision(self):
        used = self.memory.add("我在上海", "asserted_by_user")
        other = self.memory.add("喜欢猫", "inferred_hypothesis")
        revision = self.memory.revision
        self.memory.touch([used, "missing"])
        self.assertEqual({f["fact_id"]: f["last_used_at"] for f in self.memory.active()}, {used: 1003.0, other: None})
        self.assertEqual(self.memory.revision, revision)

    def test_stale_counts_from_last_use_or_recording(self):
        old = self.memory.add("我在上海", "asserted_by_user")
        used = self.memory.add("喜欢猫", "asserted_by_user")
        self.now += 31 * 86400
        self.memory.touch([used])
        fresh = self.memory.add("今天很累", "asserted_by_user")
        self.assertEqual({f["fact_id"]: f["stale"] for f in self.memory.active()},
                         {old: True, used: False, fresh: False})

    def test_clear_facts_keeps_name_and_birthday(self):
        self.memory.add("我在上海", "asserted_by_user")
        name = self.memory.add("小林", "confirmed_by_user", kind="name")
        birthday = self.memory.add("3月1日", "confirmed_by_user", kind="birthday")
        self.memory.add("喜欢狗", "asserted_by_user", kind="preference")
        revision = self.memory.revision
        self.assertEqual(self.memory.clear("facts"), 2)
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [name, birthday])
        self.assertEqual(self.memory.revision, revision + 1)
        self.assertEqual(self.memory.clear("all"), 2)
        self.assertEqual(self.memory.active(), [])

    @unittest.skipIf(sys.platform == "win32", "the test uses a file name character Windows forbids")
    def test_clear_removes_usage_only_for_the_deleted_scope(self):
        fact=self.memory.add("普通事实","asserted_by_user")
        name=self.memory.add("小林","confirmed_by_user",kind="name")
        self.memory.record_uses([(fact,1),(name,1)],"used-line","injected")
        self.memory.clear("facts")
        self.assertEqual(set(self.memory.uses()),{name})
        self.memory.clear("all")
        self.assertEqual(self.memory.uses(),{})

    def test_text_is_the_active_one(self):
        fact = self.memory.add("我在上海", "asserted_by_user")
        self.assertEqual(self.memory.text(fact), "我在上海")
        self.memory.correct(fact, "我在杭州")
        self.memory.confirm(fact)
        self.assertEqual(self.memory.text(fact), "我在杭州")
        self.memory.delete(fact)
        self.assertIsNone(self.memory.text(fact))
        self.assertIsNone(self.memory.text("missing"))

    def test_lines_are_the_lines_that_said_a_fact_again(self):
        cat = self.memory.add("我养了一只猫", "asserted_by_user")
        dog = self.memory.add("我养了一只狗", "asserted_by_user")
        self.memory.record_uses([(cat, 1)], "l1", "injected")
        self.memory.record_uses([(cat, 1)], "l2", "mentioned")
        self.memory.record_uses([(dog, 1), (cat, 1)], "l3", "mentioned")
        self.memory.record_uses([(cat, 1)], "l3", "mentioned")
        self.assertEqual(self.memory.lines(cat), ["l2", "l3"])
        self.assertEqual(self.memory.lines(dog), ["l3"])
        self.assertEqual(self.memory.lines("missing"), [])

    def test_a_setting_survives_a_reopen_until_it_is_removed(self):
        self.assertIsNone(self.memory.setting("observation_paused_until"))
        self.memory.set_setting("observation_paused_until", "4600.5")
        self.assertEqual(Memory(open_store(self.path)).setting("observation_paused_until"), "4600.5")
        self.memory.set_setting("observation_paused_until", None)
        self.assertIsNone(Memory(open_store(self.path)).setting("observation_paused_until"))
        self.assertFalse(self.memory.paused())


class SelectTest(unittest.TestCase):
    QUERY = "团子今天不吃鸡胸肉"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.db = open_store(Path(self.tmp.name) / "agentd.db")
        self.now = 100000.0
        self.memory = Memory(self.db, clock=lambda: self.now)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def picked(self, query, **options):
        facts = self.memory.select(query, now=self.now, **options)
        return [f["fact_id"] for f in facts["trusted"]], [f["fact_id"] for f in facts["low_trust"]]

    def add(self, text, source="asserted_by_user", kind="fact"):
        self.now += 1
        return self.memory.add(text, source, kind=kind)

    def used(self, fact_id, mode, ago):
        at, self.now = self.now, self.now - ago
        self.memory.record_uses([(fact_id, 1)], f"line-{fact_id}-{mode}-{ago}", mode)
        self.now = at

    def test_similar_keeps_recency_order_at_the_cutoff(self):
        ids = [self.add(text) for text in ("团子甲", "团子乙", "团子丙")]
        def similar(k):
            return [f["fact_id"] for f in self.memory.similar("团子", "fact", k)]
        self.assertEqual(similar(2), ids[:0:-1])
        self.assertEqual(similar(0), [])
        self.assertEqual(similar(-1), ids[:0:-1])

    def test_ranks_by_bigram_overlap_times_evidence_and_keeps_k(self):
        cat = self.add("我养的猫叫团子")
        food = self.add("团子爱吃鸡胸肉")
        self.add("我在上海工作")
        self.assertEqual(self.picked(self.QUERY), ([food, cat], []))
        self.assertEqual(self.picked(self.QUERY, k=1), ([food], []))
        for _ in range(4):
            self.memory.reinforce("我养的猫叫团子")
        self.assertEqual(self.picked(self.QUERY), ([cat, food], []))

    def test_an_unrelated_or_barely_related_query_gets_nothing(self):
        self.add("团子爱吃鸡胸肉")
        self.add("我每天早上都要喝一杯咖啡")
        self.assertEqual(self.picked("今晚吃什么"), ([], []))
        self.assertEqual(self.picked("今天咖啡店人好多"), ([], []))  # one shared bigram of seven
        self.assertEqual(self.picked(""), ([], []))

    def test_recent_injection_halves_and_a_recent_mention_cuts_to_three_tenths(self):
        quarter_old, quarter_new = self.add("团子怕吹风"), self.add("团子怕打雷")  # 1 of 4 bigrams
        third_injected, third_mentioned, third_old_mention = \
            self.add("团子很乖"), self.add("团子很凶"), self.add("团子很胖")  # 1 of 3 bigrams
        self.used(quarter_old, "injected", 7 * 3600)
        self.used(quarter_new, "injected", 3600)
        self.used(third_injected, "injected", 3600)
        self.used(third_mentioned, "mentioned", 2 * 86400)
        self.used(third_old_mention, "mentioned", 4 * 86400)
        trusted, _ = self.picked(self.QUERY, k=5)
        self.assertEqual(set(trusted), {quarter_old, third_injected, third_old_mention})

    def test_name_and_agreements_are_resident_up_to_three(self):
        name = self.add("小林", "confirmed_by_user", "name")
        first = self.add("周五一起打球", kind="agreement")
        second = self.add("周六一起看电影", kind="agreement")
        third = self.add("周日一起去爬山", kind="agreement")
        self.add("可能约了周一", "inferred_hypothesis", "agreement")
        trusted, low = self.picked("今晚吃什么")
        self.assertEqual((trusted, low), ([name, third, second], []))
        self.assertNotIn(first, trusted)
        food = self.add("团子爱吃鸡胸肉")
        self.assertEqual(self.picked(self.QUERY)[0], [name, third, second, food])

    def test_the_fact_block_stays_within_its_characters(self):
        self.add("小林", "confirmed_by_user", "name")
        long = self.add("团子" + "乖" * 150)
        self.memory.reinforce("团子" + "乖" * 150)
        short = self.add("团子很乖")
        fat = self.add("团子" + "胖" * 60)  # newer, so it ranks above short and is cut to the room left
        facts = self.memory.select("团子", now=self.now)
        self.assertEqual([f["fact_id"] for f in facts["trusted"]][1:], [long, fat])
        self.assertNotIn(short, [f["fact_id"] for f in facts["trusted"]])
        self.assertTrue(facts["trusted"][2]["text"].endswith("…（完整见记忆页）"))
        self.assertEqual(sum(len(f["text"]) for f in facts["trusted"]), SELECT_CHARS)
        self.assertEqual(SELECT_CHARS, 200)

    def test_a_fact_longer_than_the_room_left_is_cut_and_marked(self):
        text = "团子" + "乖" * 298
        long = self.add(text)
        [fact] = self.memory.select("团子", now=self.now)["trusted"]
        self.assertEqual(fact["fact_id"], long)
        self.assertEqual(len(fact["text"]), SELECT_CHARS)
        self.assertEqual(fact["text"], text[:SELECT_CHARS - 9] + "…（完整见记忆页）")
        self.assertEqual(self.memory.text(long), text)

    def test_a_fact_is_cut_only_while_twenty_characters_and_the_mark_still_fit(self):
        first = self.add("团子" + "乖" * 169)  # 171 characters: 29 left, 20 and the 9 of the mark
        self.memory.reinforce("团子" + "乖" * 169)
        second = self.add("团子" + "胖" * 60)
        facts = self.memory.select("团子", now=self.now)["trusted"]
        self.assertEqual([f["fact_id"] for f in facts], [first, second])
        self.assertEqual(facts[1]["text"], "团子" + "胖" * 18 + "…（完整见记忆页）")
        self.now += 1
        self.memory.correct(first, "团子" + "乖" * 172)  # newest, 174 characters: 26 left
        self.assertEqual(self.picked("团子"), ([first], []))

    def test_low_trust_facts_need_a_high_overlap(self):
        guess = self.add("团子可能怕猫", "inferred_hypothesis")
        self.assertEqual(self.picked(self.QUERY), ([], []))
        self.assertEqual(self.picked("团子可能怕猫吗", derived=True), ([], [guess]))

    def test_observed_facts_need_derived_and_trusted_ones_do_not(self):
        guess = self.add("团子可能怕猫", "inferred_hypothesis")
        seen = self.add("团子怕猫", "observed_context")
        told = self.add("团子怕猫狗", "asserted_by_user")
        self.assertEqual(self.picked("团子可能怕猫吗", k=3), ([told], []))
        self.assertEqual(self.picked("团子可能怕猫吗", k=3, derived=True), ([told], [guess, seen]))

    def test_mentions_need_four_characters_in_a_row_or_three_tenths_of_the_bigrams(self):
        self.assertTrue(mentions("今天上海工作好忙吧", "我在上海工作"))
        self.assertTrue(mentions("团子吃鸡了吗", "团子爱吃鸡胸肉"))
        self.assertFalse(mentions("嗯，知道了。", "我在上海工作"))
        self.assertFalse(mentions("上海下雨了", "我在上海工作"))

    def test_uses_count_lines_today_and_keep_the_last_five(self):
        self.now = datetime.datetime(2026, 10, 22, 12).timestamp()  # local noon: every use below is today
        fact = self.add("团子很乖")
        other = self.add("我在上海")
        self.used(fact, "injected", 86400 * 2)
        for n in range(3):
            self.now += 10
            self.memory.record_uses([(fact, 1)], f"l{n}", "injected")
        self.memory.record_uses([(fact, 1)], "l2", "mentioned")
        uses = self.memory.uses(now=self.now)
        self.assertEqual(uses[fact]["uses_today"], 3)
        self.assertEqual((uses[fact]["last_injected_at"], uses[fact]["last_mentioned_at"]), (self.now, self.now))
        self.assertEqual([(u["line_id"], u["mode"]) for u in uses[fact]["recent_uses"]],
                         [("l2", "mentioned"), ("l2", "injected"), ("l1", "injected"), ("l0", "injected"),
                          (f"line-{fact}-injected-172800", "injected")])
        self.assertNotIn(other, uses)


class ConsolidatedTest(unittest.TestCase):
    """Facts consolidated from episodes, as candidates or active, and their delete with the episodes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.db = open_store(Path(self.tmp.name) / "agentd.db")
        self.now = 100000.0
        self.memory = Memory(self.db, clock=lambda: self.now)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def rows(self, fact_id):
        return self.db.execute("SELECT version, text, state FROM facts WHERE fact_id = ? ORDER BY id",
                               (fact_id,)).fetchall()

    def test_a_candidate_is_observed_or_inferred_and_never_injected(self):
        for source in ("asserted_by_user", "confirmed_by_user"):
            with self.assertRaises(ValueError):
                self.memory.add("我养的猫叫团子", source, state="candidate")
        with self.assertRaises(ValueError):
            self.memory.add("我养的猫叫团子", "inferred_hypothesis", state="corrected")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM facts").fetchone()[0], 0)
        seen = self.memory.add("我养的猫叫团子", "observed_context", evidence=["episode:1@2026-10-23"],
                               state="candidate")
        guess = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", state="candidate")
        self.assertEqual(self.memory.revision, 2)
        self.assertEqual((self.rows(seen), self.rows(guess)), ([(1, "我养的猫叫团子", "candidate")],
                                                               [(1, "可能常在晚上写代码", "candidate")]))
        self.assertEqual((self.memory.active(), self.memory.export()), ([], []))
        self.assertEqual(self.memory.select("我养的猫叫团子"), {"trusted": [], "low_trust": []})
        self.assertIsNone(self.memory.text(seen))
        self.memory.set_paused(True)
        self.assertIsNone(self.memory.add("可能喜欢猫", "inferred_hypothesis", state="candidate"))

    def test_support_adds_evidence_and_a_signal_but_keeps_the_text(self):
        fact = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=["episode:1@2026-10-21", "x"])
        revision = self.memory.revision
        self.now += 10
        self.assertTrue(self.memory.support(fact, ["episode:2@2026-10-22", "episode:1@2026-10-21"]))
        [row] = self.memory.consolidated()
        self.assertEqual((row["fact_id"], row["version"], row["text"], row["state"], row["evidence"]),
                         (fact, 1, "可能常在晚上写代码", "active", ["episode:1@2026-10-21", "x", "episode:2@2026-10-22"]))
        self.assertEqual((row["reinforcement"], row["reinforced_at"]), (1, self.now))
        self.assertEqual(self.memory.revision, revision + 1)
        candidate = self.memory.add("可能喜欢猫", "observed_context", evidence=["episode:3@2026-10-22"],
                                    state="candidate")
        self.assertTrue(self.memory.support(candidate, ["episode:4@2026-10-23"]))
        self.assertEqual(self.rows(candidate), [(1, "可能喜欢猫", "candidate")])

    def test_support_refuses_paused_missing_and_user_facts(self):
        told = self.memory.add("我在上海", "asserted_by_user", evidence=["episode:1@2026-10-21"])
        confirmed = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=["episode:1@2026-10-21"])
        self.memory.confirm(confirmed)
        guess = self.memory.add("可能喜欢猫", "inferred_hypothesis", evidence=["episode:1@2026-10-21"])
        revision = self.memory.revision
        for fact_id in (told, confirmed, "missing"):
            self.assertFalse(self.memory.support(fact_id, ["episode:2@2026-10-22"]), fact_id)
        self.memory.set_paused(True)
        self.assertFalse(self.memory.support(guess, ["episode:2@2026-10-22"]))
        self.assertEqual(self.memory.revision, revision)
        self.assertEqual([f["evidence"] for f in self.memory.consolidated()], [["episode:1@2026-10-21"]])

    def test_promote_makes_a_candidate_active(self):
        candidate = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", state="candidate")
        active = self.memory.add("可能喜欢猫", "inferred_hypothesis")
        self.assertTrue(self.memory.promote(candidate))
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [candidate, active])
        for fact_id in (candidate, active, "missing"):
            self.assertFalse(self.memory.promote(fact_id), fact_id)

    def test_consolidated_lists_observed_facts_with_episode_evidence(self):
        guess = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=["episode:1@2026-10-21"])
        candidate = self.memory.add("可能喜欢猫", "observed_context", evidence=["obs-1", "episode:2@2026-10-22"],
                                    state="candidate")
        self.memory.add("在看网页", "observed_context", evidence=["obs-1"])
        self.memory.add("我在上海", "asserted_by_user", evidence=["episode:1@2026-10-21"])
        confirmed = self.memory.add("在写 agentd", "observed_context", evidence=["episode:1@2026-10-21"])
        self.memory.confirm(confirmed)
        deleted = self.memory.add("在看视频", "observed_context", evidence=["episode:1@2026-10-21"])
        self.memory.delete(deleted)
        self.assertEqual([(f["fact_id"], f["state"], f["evidence"]) for f in self.memory.consolidated()],
                         [(guess, "active", ["episode:1@2026-10-21"]),
                          (candidate, "candidate", ["obs-1", "episode:2@2026-10-22"])])
        self.assertEqual(set(self.memory.consolidated()[0]), {*COLUMNS, "state"})

    def test_delete_derived_takes_the_facts_of_the_given_episodes(self):
        one = self.memory.add("可能常在晚上写代码", "inferred_hypothesis",
                              evidence=["episode:3@2026-10-20", "episode:1@2026-10-21"])
        candidate = self.memory.add("可能喜欢猫", "observed_context", evidence=["episode:1@2026-10-21"],
                                    state="candidate")
        other = self.memory.add("在看网页", "observed_context", evidence=["episode:12@2026-10-21", "episode:2@x"])
        told = self.memory.add("我在上海", "asserted_by_user", evidence=["episode:1@2026-10-21"])
        confirmed = self.memory.add("在写 agentd", "observed_context", evidence=["episode:1@2026-10-21"])
        self.memory.confirm(confirmed)
        revision = self.memory.revision
        self.assertEqual(self.memory.delete_derived([5, 6]), [])
        self.assertEqual(self.memory.revision, revision)
        self.assertEqual(sorted(self.memory.delete_derived([1])), sorted([one, candidate]))
        self.assertEqual(self.memory.revision, revision + 1)
        self.assertEqual(self.rows(one), [(1, None, "deleted")])
        self.assertEqual(self.rows(candidate), [(1, None, "deleted")])
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [other, told, confirmed])
        self.assertEqual(self.rows(confirmed), [(1, "在写 agentd", "corrected"), (2, "在写 agentd", "active")])

    def test_delete_derived_without_ids_takes_every_episode_fact(self):
        guess = self.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=["episode:1@2026-10-21"])
        candidate = self.memory.add("可能喜欢猫", "observed_context", evidence=["episode:9@2026-10-22"],
                                    state="candidate")
        page = self.memory.add("在看网页", "observed_context", evidence=["obs-1"])
        self.assertEqual(sorted(self.memory.delete_derived()), sorted([guess, candidate]))
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [page])
        self.assertEqual(self.memory.delete_derived(), [])

    def test_delete_since_takes_candidates_too(self):
        self.memory.add("以前猜的", "inferred_hypothesis", state="candidate")
        self.now += 100
        candidate = self.memory.add("刚才猜的", "inferred_hypothesis", state="candidate")
        self.assertEqual(self.memory.delete_since(self.now, ("observed_context", "inferred_hypothesis")), [candidate])
        self.assertEqual(self.rows(candidate), [(1, None, "deleted")])


class FactMarksTest(unittest.TestCase):
    """Version history with who wrote each version, locked facts and facts marked 不再提及 (quiet)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.path = Path(self.tmp.name) / "agentd.db"
        self.db = open_store(self.path)
        self.now = 1000.0
        self.memory = Memory(self.db, clock=self.tick)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def tick(self):
        self.now += 1
        return self.now

    def answer(self, call, *args, body=None):
        answers = []
        handler = SimpleNamespace(server=SimpleNamespace(memory=self.memory, feed=SimpleNamespace(publish=lambda *a: None)),
                                  _json=lambda *a: answers.append(a))
        handler._memory_body = lambda: (self.memory, body)
        call(handler, *args)
        return answers[0]

    def test_versions_keep_each_text_with_who_wrote_it(self):
        ident = self.memory.add("周五写周报", "inferred_hypothesis", state="candidate", by="integration")
        self.memory.confirm(ident, expected_version=1)
        self.memory.correct(ident, "每周五下午写周报", expected_version=2)
        self.assertEqual([(v["version"], v["text"], v["source"], v["by"]) for v in self.memory.versions(ident)], [
            (1, "周五写周报", "inferred_hypothesis", "integration"),
            (2, "周五写周报", "confirmed_by_user", "user"),
            (3, "每周五下午写周报", "confirmed_by_user", "user")])
        at = [v["at"] for v in self.memory.versions(ident)]
        self.assertEqual(at, sorted(set(at)))
        self.memory.delete(ident, expected_version=3)
        with self.assertRaises(KeyError):
            self.memory.versions(ident)
        self.assertEqual(self.answer(MemoryMixin._fact_versions_get, ident), (404, {"error": "unknown_fact"}))

    @unittest.skipIf(sys.platform == "win32", "the test uses a file name character Windows forbids")
    def test_versions_response_matches_fixture(self):
        ident = self.memory.add("回答先给结论", "asserted_by_user")
        status, body = self.answer(MemoryMixin._fact_versions_get, ident)
        self.assertEqual(status, 200)
        fixture = json.loads((FIXTURES / "memory-versions.json").read_text(encoding="utf-8"))
        self.assertEqual(mismatches(fixture, body, ["versions[].by"], []), [])

    def test_store_without_the_new_columns_reads_with_defaults(self):
        self.db.close()
        old = Path(self.tmp.name) / "old.db"
        import sqlite3
        db = sqlite3.connect(old)
        db.executescript("""
            CREATE TABLE facts (id INTEGER PRIMARY KEY, fact_id TEXT NOT NULL, version INTEGER NOT NULL,
                kind TEXT NOT NULL, text TEXT, source TEXT NOT NULL, evidence TEXT NOT NULL, occurred_at REAL,
                recorded_at REAL NOT NULL, state TEXT NOT NULL, last_used_at REAL, reinforcement REAL NOT NULL DEFAULT 0,
                reinforced_at REAL, owner TEXT, UNIQUE(fact_id, version));
            INSERT INTO facts (fact_id, version, kind, text, source, evidence, recorded_at, state)
                VALUES ('old', 1, 'fact', '旧的一条', 'asserted_by_user', '[]', 5.0, 'active');
        """)
        db.close()
        self.db = open_store(old)
        self.memory = Memory(self.db, clock=self.tick)
        [fact] = self.memory.active()
        self.assertEqual((fact["text"], fact["locked"], fact["quiet"]), ("旧的一条", False, False))
        self.assertEqual(self.memory.versions("old"), [{"version": 1, "text": "旧的一条", "source": "asserted_by_user",
                                                         "by": None, "at": 5.0}])
        self.memory.set_mark("old", "quiet", True)
        self.assertTrue(self.memory.active()[0]["quiet"])

    def test_marks_are_set_and_cleared_through_the_routes(self):
        ident = self.memory.add("提交前先跑测试", "asserted_by_user", kind="agreement")
        self.assertEqual(self.answer(MemoryMixin._fact_mark_put, ident, "locked", body={"locked": "yes"}),
                         (400, {"error": "invalid_payload"}))
        self.assertEqual(self.answer(MemoryMixin._fact_mark_put, "nope", "locked", body={"locked": True}),
                         (404, {"error": "unknown_fact"}))
        self.assertEqual(self.answer(MemoryMixin._fact_mark_put, ident, "locked", body={"locked": True}), (200, {"locked": True}))
        self.assertEqual(self.answer(MemoryMixin._fact_mark_put, ident, "quiet", body={"quiet": True}), (200, {"quiet": True}))
        status, body = self.answer(MemoryMixin._memory_read, "/memory")
        self.assertEqual([(f["locked"], f["quiet"]) for f in body["facts"]], [(True, True)])
        self.memory.correct(ident, "提交前先跑全部测试", expected_version=1)
        self.assertEqual((self.memory.active()[0]["locked"], self.memory.active()[0]["quiet"]), (True, True))
        self.answer(MemoryMixin._fact_mark_put, ident, "locked", body={"locked": False})
        self.assertEqual((self.memory.active()[0]["locked"], self.memory.active()[0]["quiet"]), (False, True))

    def test_locked_fact_is_not_supported_by_consolidation(self):
        ident = self.memory.add("周报按项目分组", "observed_context", evidence=["episode:1@2026-10-31"])
        self.memory.set_mark(ident, "locked", True)
        self.assertFalse(self.memory.support(ident, ["episode:2@2026-11-01"]))
        self.assertEqual(self.memory.active()[0]["evidence"], ["episode:1@2026-10-31"])
        self.memory.set_mark(ident, "locked", False)
        self.assertTrue(self.memory.support(ident, ["episode:2@2026-11-01"]))

    def test_quiet_fact_is_not_injected_but_still_kept(self):
        quiet = self.memory.add("我养了一只叫团子的猫", "asserted_by_user")
        self.memory.add("团子喜欢晒太阳", "asserted_by_user")
        self.memory.set_mark(quiet, "quiet", True)
        self.assertNotIn(quiet, [f["fact_id"] for f in self.memory.select("团子", now=self.now)["trusted"]])
        self.assertNotIn(quiet, [f["fact_id"] for f in self.memory.injectable()["trusted"]])
        self.assertIn(quiet, [f["fact_id"] for f in self.memory.active()])

    def test_clear_all_drops_the_marks(self):
        ident = self.memory.add("提交前先跑测试", "asserted_by_user")
        self.memory.set_mark(ident, "locked", True)
        self.memory.clear("all")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM fact_marks").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
