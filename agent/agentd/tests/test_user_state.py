from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation import user_state  # noqa: E402
from observation.user_state import UserState, derive  # noqa: E402

T0 = 1792300000.0
CODE = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "window_id": 2, "title": "server.py"}
TERMINAL = {"app": "Terminal", "bundle_id": "com.apple.Terminal", "window_id": 3, "title": "zsh"}
CHROME = {"app": "Chrome", "bundle_id": "com.google.Chrome", "window_id": 4, "title": "搜索"}
NOTES = {"app": "Notes", "bundle_id": "com.example.notes", "window_id": 5, "title": "笔记"}
SPOTIFY = {"app": "Spotify", "bundle_id": "com.spotify.client", "window_id": 6, "title": "Spotify"}
ERROR = "$ make\nerror: cannot find module 'foo' at /w/src/{}.py:{}\n"


def inputs(focus=CODE, counts=None, dwell=10.0, sessions=(), own=(), outcomes=(), page=None):
    presence = None if counts is None else {"id": "presence:x", "status": "active", "seconds": 60.0, "idle_s": 0.0,
                                            "inputs": [{"ts": T0, "input": counts}], "apps_60s": None}
    return {"now": T0, "focus": focus and {**focus, "id": "focus:x", "since": T0 - dwell}, "dwell_s": dwell,
            "presence": presence, "camera_active": False, "page": page, "recent_pages": [], "selection": None,
            "window_text": None, "observations": [], "sessions": list(sessions), "own_sessions": list(own),
            "events": list(outcomes)}


def scene(activity="unknown", subject=None, related=()):
    return {"activity": activity, "subject": subject, "related_session_ids": list(related)}


def raw(ago, kind="value", app="Code", bundle="com.microsoft.VSCode", **extra):
    return {"id": None, "ts": T0 - ago, "kind": kind, "app": app, "bundle_id": bundle, "window": None,
            "url_host": None, "doc": None, "role": "AXTextArea", "subrole": None, "label": None, "value": None,
            "value_len": None, "shrink": 0, "edits": 1, **extra}


def term(ago, value):
    return raw(ago, app="Terminal", bundle="com.apple.Terminal", value=value)


def outcome(ago, kind):
    return {"id": f"event:{ago}", "session": "claude:A", "kind": kind, "tool": "Bash", "tool_category": "command",
            "ts": T0 - ago}


def run(events=(), activity="unknown", subject=None, related=(), **kw):
    return derive(list(events), inputs(**kw), scene(activity, subject, related), T0)


def typed(field, *lens_shrinks, start=250, app="Code", bundle="com.microsoft.VSCode", step=20):
    """Value events of one field, step seconds apart from start seconds ago."""
    return [raw(start - i * step, app=app, bundle=bundle, label=field, value_len=n, shrink=s)
            for i, (n, s) in enumerate(lens_shrinks)]


REPEAT_TWICE = [term(400, ERROR.format("a", 12)), term(300, ERROR.format("b", 40))]


class ModeTest(unittest.TestCase):
    def mode(self, *args, **kw):
        return run(*args, **kw)["mode"]

    def test_away_and_meeting_come_from_the_scene(self):
        self.assertEqual(self.mode(activity="away"), "away")
        self.assertEqual(self.mode(activity="meeting"), "meeting")

    def test_relaxing_by_video_or_game(self):
        self.assertEqual(self.mode(activity="watching_video", focus=NOTES), "relaxing")
        self.assertEqual(self.mode(activity="gaming", focus=NOTES), "relaxing")

    def test_relaxing_by_a_relax_host_suffix(self):
        self.assertEqual(self.mode(focus={**CHROME, "url_host": "m.weibo.com"}), "relaxing")
        self.assertEqual(self.mode(focus=CHROME, page={"id": "page:x", "url_host": "www.reddit.com"}), "relaxing")
        self.assertEqual(self.mode(focus={**CHROME, "url_host": "notweibo.com"}), "other")

    def test_relaxing_by_music_only_without_typing(self):
        self.assertEqual(self.mode(focus=SPOTIFY), "relaxing")
        self.assertEqual(self.mode([raw(100, app="Spotify", bundle="com.spotify.client", value_len=3)],
                                   focus=SPOTIFY), "other")

    def test_coding_by_activity(self):
        self.assertEqual(self.mode(activity="editing_code", focus=NOTES), "coding")
        self.assertEqual(self.mode(activity="build_failed", focus=NOTES), "coding")

    def test_coding_by_front_category(self):
        self.assertEqual(self.mode(focus=TERMINAL), "coding")
        self.assertEqual(self.mode(focus=CODE), "coding")

    def test_coding_by_an_active_own_or_related_session(self):
        self.assertEqual(self.mode(focus=NOTES, own=[{"session_id": "s1", "state": "running_tool"}]), "coding")
        self.assertEqual(self.mode(focus=NOTES, own=[{"session_id": "s1", "state": "done"}]), "other")
        session = {"display_session": "claude:A", "observed_at": T0 - 60}
        self.assertEqual(self.mode(focus=NOTES, sessions=[session], related=["claude:A"]), "coding")
        self.assertEqual(self.mode(focus=NOTES, sessions=[session]), "other")
        self.assertEqual(self.mode(focus=NOTES, sessions=[{**session, "observed_at": T0 - 200}],
                                   related=["claude:A"]), "other")

    def test_reading(self):
        self.assertEqual(self.mode(activity="reading", focus=CHROME), "reading")
        self.assertEqual(self.mode(activity="comparing_sources", focus=CHROME), "reading")

    def test_writing_needs_fifty_chars_of_net_growth_outside_code(self):
        grew = typed("正文", (10, 0), (40, 0), (70, 0), app="Notes", bundle="com.example.notes")
        self.assertEqual(self.mode(grew, focus=NOTES), "writing")
        short = typed("正文", (10, 0), (40, 0), (59, 0), app="Notes", bundle="com.example.notes")
        self.assertEqual(self.mode(short, focus=NOTES), "other")
        old = typed("正文", (10, 0), (40, 0), (70, 0), start=400, step=50, app="Notes", bundle="com.example.notes")
        self.assertEqual(self.mode(old, focus=NOTES), "other")

    def test_other(self):
        self.assertEqual(self.mode(focus=NOTES), "other")
        self.assertEqual(self.mode(focus=None), "other")


class StuckTest(unittest.TestCase):
    """One clue alone is not stuck (except one error line in three events); two clues are."""

    def stuck(self, events=(), **kw):
        result = run(events, activity="editing_code", **kw)
        return result["state"] == "stuck", result["evidence"]

    def assert_clue(self, clue, events=(), **kw):
        self.assertFalse(self.stuck(events, **kw)[0])
        stuck, evidence = self.stuck([*REPEAT_TWICE, *events], **kw)
        self.assertTrue(stuck)
        self.assertLessEqual({clue, "repeat_error"}, set(evidence))

    def test_repeat_error_twice_is_one_clue(self):
        self.assertFalse(self.stuck(REPEAT_TWICE)[0])
        self.assertFalse(self.stuck([term(300, ERROR.format("a", 12))])[0])

    def test_repeat_error_three_times_is_stuck_alone(self):
        stuck, evidence = self.stuck([*REPEAT_TWICE, term(10, ERROR.format("c", 7))])
        self.assertTrue(stuck)
        self.assertIn("repeat_error", evidence)

    def test_repeat_error_counts_only_ten_minutes(self):
        self.assertFalse(self.stuck([term(700, ERROR.format("x", 1)), *REPEAT_TWICE])[0])

    def test_fail_loop(self):
        self.assert_clue("fail_loop", outcomes=[outcome(300, "tool_failure"), outcome(100, "error")])
        self.assertFalse(self.stuck(REPEAT_TWICE, outcomes=[outcome(300, "tool_failure"), outcome(200, "done"),
                                                            outcome(100, "error")])[0])

    def test_backspace(self):
        self.assert_clue("backspace", typed("编辑器", (20, 0), (25, 5), (22, 6)))
        self.assertFalse(self.stuck([*REPEAT_TWICE, *typed("编辑器", (20, 0), (60, 1), (100, 0))])[0])

    def test_search_error(self):
        switches = [raw(250, "app"), raw(200, "app", "Chrome", "com.google.Chrome",
                                         window="undefined symbol bar_baz - Google 搜索"),
                    raw(150, "app"), raw(100, "app", "Chrome", "com.google.Chrome"), raw(50, "app")]
        self.assert_clue("search_error", [term(450, "ld: error: undefined symbol bar_baz\n"), *switches])
        self.assertFalse(self.stuck([*REPEAT_TWICE, *switches[:4]])[0])

    def test_search_error_in_japanese(self):
        switches = [raw(250, "app"), raw(200, "app", "Chrome", "com.google.Chrome",
                                         window="シンボル bar_baz - Google 検索"),
                    raw(150, "app"), raw(100, "app", "Chrome", "com.google.Chrome"), raw(50, "app")]
        self.assert_clue("search_error", [term(450, "コンパイルエラー: シンボル bar_baz\n"), *switches])

    def test_ask_again(self):
        prompts = [raw(300, "prompt", "claude", None, value="帮我看看为什么 foo 模块找不到"),
                   raw(100, "prompt", "claude", None, value="帮我看看为什么 foo 模块还是找不到")]
        self.assert_clue("ask_again", prompts)
        other = [prompts[0], raw(100, "prompt", "claude", None, value="写一个排序函数")]
        self.assertFalse(self.stuck([*REPEAT_TWICE, *other])[0])

    def test_only_while_coding(self):
        three = [*REPEAT_TWICE, term(10, ERROR.format("c", 7))]
        self.assertNotEqual(derive(three, inputs(focus=NOTES), scene("reading"), T0)["state"], "stuck")


class InterpretedBlockerTest(unittest.TestCase):
    """The interpreter's blocked task for the focus window is the blocker the stuck line reads; rules come first."""

    def derive(self, events=(), task_state="blocked", activity="unknown"):
        task = {"task_key": "render-fix", "title": "修复渲染编译：缺少 RenderTarget 声明", "summary": "检查声明",
                "state": task_state, "observed_at": T0 - 20}
        return derive(list(events), inputs(focus=NOTES), {**scene(activity), "interpreted": task}, T0)

    def test_blocked_task_marks_the_blocker_and_keeps_the_state(self):
        result = self.derive()
        self.assertEqual(result["blocker"], "修复渲染编译：缺少 RenderTarget 声明")
        self.assertEqual(result["state"], "unknown")

    def test_other_task_states_mark_nothing(self):
        for state in ("working", "reading", "result_observed"):
            with self.subTest(state=state):
                self.assertIsNone(self.derive(task_state=state)["blocker"])

    def test_a_rule_blocker_wins(self):
        three = [*REPEAT_TWICE, term(10, ERROR.format("c", 7))]
        result = derive(three, inputs(focus=CODE), {**scene("editing_code"), "interpreted": {
            "task_key": "k", "title": "别的事", "summary": "", "state": "blocked", "observed_at": T0}}, T0)
        self.assertEqual(result["state"], "stuck")
        self.assertIn("cannot find module", result["blocker"])


class StateTest(unittest.TestCase):
    def test_flowing(self):
        events = typed("编辑器", (100, 0), (110, 0), (130, 0))
        result = run(events, activity="editing_code", counts={"switches_60s": 1, "keys_60s": 40})
        self.assertEqual((result["mode"], result["state"]), ("coding", "flowing"))
        self.assertNotEqual(run(events, activity="editing_code", counts={"switches_60s": 3})["state"], "flowing")
        self.assertNotEqual(run(events, activity="editing_code", outcomes=[outcome(100, "tool_failure")])["state"],
                            "flowing")
        self.assertEqual(run(events, activity="editing_code",
                             outcomes=[outcome(100, "tool_failure"), outcome(50, "done")])["state"], "flowing")

    def test_searching(self):
        self.assertEqual(run(activity="switching", focus=NOTES)["state"], "searching")
        self.assertEqual(run(focus=NOTES, counts={"switches_60s": 6})["state"], "searching")
        self.assertNotEqual(run([term(100, ERROR.format("a", 1))], activity="switching", focus=NOTES)["state"],
                            "searching")

    def test_idle(self):
        still = {"keys_60s": 0, "scrolls_30s": 0}
        self.assertEqual(run(focus=NOTES, dwell=200.0, counts=still)["state"], "idle")
        self.assertEqual(run(focus=NOTES, dwell=100.0, counts=still)["state"], "unknown")
        self.assertEqual(run(focus=NOTES, dwell=200.0, counts={**still, "scrolls_30s": 2})["state"], "unknown")
        self.assertEqual(run(activity="away", focus=NOTES, dwell=200.0, counts=still)["state"], "unknown")


class OnMindTest(unittest.TestCase):
    def on_mind(self, events, focus=NOTES):
        return run(events, focus=focus)["on_mind"]

    def test_three_sources(self):
        self.assertEqual(self.on_mind([raw(30, "prompt", "claude", None, value="帮我看看这个报错")]),
                         {"text": "帮我看看这个报错", "source": "prompt", "ts": T0 - 30})
        self.assertEqual(self.on_mind([raw(30, role="AXSearchField", value="foo 模块")])["source"], "search")
        self.assertEqual(self.on_mind([raw(30, role="AXComboBox", value="foo")])["source"], "search")
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", label="Search docs", value="foo")])["source"],
                         "search")
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", label="查找", value="foo")])["source"], "search")
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", label="検索", value="foo")])["source"], "search")
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", value="明天见")])["source"], "field")
        notes = raw(30, app="Notes", bundle="com.example.notes", value="一段笔记")
        self.assertEqual(self.on_mind([notes])["source"], "field")

    def test_text_area_in_code_does_not_count(self):
        self.assertIsNone(self.on_mind([raw(30, value="def f(): pass")], focus=CODE))
        self.assertIsNone(self.on_mind([raw(30, role="AXStaticText", value="foo")]))

    def test_the_last_one_wins(self):
        events = [raw(60, "prompt", "claude", None, value="先问一句"), raw(30, role="AXTextField", value="后写一句")]
        self.assertEqual(self.on_mind(events)["text"], "后写一句")

    def test_only_two_minutes(self):
        self.assertIsNone(self.on_mind([raw(130, role="AXTextField", value="很久以前")]))

    def test_last_sentence_cut_to_sixty(self):
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", value="前面一句。最后一句！")])["text"], "最后一句")
        long = "第一句。" + "字" * 70
        self.assertEqual(self.on_mind([raw(30, role="AXTextField", value=long)])["text"], "字" * 60)


class BlockerTest(unittest.TestCase):
    def test_the_last_repeated_error_line_when_stuck(self):
        events = [*REPEAT_TWICE, term(10, ERROR.format("c", 7))]
        result = run(events, activity="editing_code")
        self.assertEqual(result["blocker"], "error: cannot find module 'foo' at /w/src/c.py:7")
        long = "error: " + "x" * 100
        result = run([term(300, long), term(200, long), term(100, long)], activity="editing_code")
        self.assertEqual(result["blocker"], long[:80])

    def test_none_unless_stuck(self):
        self.assertIsNone(run(REPEAT_TWICE, activity="editing_code")["blocker"])


class ThreadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_the_git_root_of_the_front_doc(self):
        repo = self.root / "Endfield"
        (repo / ".git").mkdir(parents=True)
        (repo / "src" / "a").mkdir(parents=True)
        doc = str(repo / "src" / "a" / "x.py")
        events = [raw(30, "window", doc=doc), raw(20, "prompt", "claude", None, doc=str(self.root))]
        self.assertEqual(run(events, subject="server.py")["thread"], "Endfield")

    def test_the_subject_without_a_repo_then_none(self):
        (self.root / "plain").mkdir()
        events = [raw(30, "window", doc=str(self.root / "plain" / "x.txt"))]
        self.assertEqual(run(events, subject="server.py")["thread"], "server.py")
        self.assertIsNone(run(events)["thread"])

    def test_the_doc_of_another_app_does_not_count(self):
        repo = self.root / "repo"
        (repo / ".git").mkdir(parents=True)
        events = [raw(30, "window", "Notes", "com.example.notes", doc=str(repo / "x.md"))]
        self.assertIsNone(run(events)["thread"])

    def test_at_most_eight_levels_up(self):
        repo = self.root / "deep"
        (repo / ".git").mkdir(parents=True)
        near = repo.joinpath(*"abcdefg")
        far = repo.joinpath(*"abcdefgh")
        far.mkdir(parents=True)
        self.assertEqual(run([raw(30, "window", doc=str(near / "x.py"))])["thread"], "deep")
        self.assertIsNone(run([raw(30, "window", doc=str(far / "x.py"))])["thread"])


def derived(mode, state="unknown", **extra):
    return {"mode": mode, "state": state, "thread": None, "on_mind": None, "blocker": None, "evidence": [],
            **extra}


class UserStateTest(unittest.TestCase):
    def setUp(self):
        self.logged = []
        self.state = UserState(lambda *row: self.logged.append(row))

    def update(self, at, mode, state="unknown", absence=None, **extra):
        return self.state.update(derived(mode, state, **extra), T0 + at, absence=absence)

    def test_the_first_result_takes_effect_at_once(self):
        self.assertEqual(self.update(0, "coding")["mode"], "coding")
        self.assertEqual(self.logged, [(T0, "coding", "unknown", [])])

    def test_a_change_takes_effect_after_thirty_seconds(self):
        self.update(0, "coding", "flowing", evidence=["steady_typing"])
        self.assertEqual(self.update(5, "reading")["mode"], "coding")
        self.assertEqual(self.update(34, "reading")["mode"], "coding")
        self.assertEqual(self.update(35, "reading")["mode"], "reading")
        self.assertEqual(self.logged, [(T0, "coding", "flowing", ["steady_typing"]), (T0 + 35, "reading", "unknown", [])])
        self.update(40, "reading")
        self.assertEqual(len(self.logged), 2)

    def test_a_change_that_does_not_hold_starts_over(self):
        self.update(0, "coding")
        self.update(5, "coding", "stuck")
        self.update(20, "coding")
        self.update(30, "coding", "stuck")
        self.assertEqual(self.update(50, "coding", "stuck")["state"], "unknown")
        self.assertEqual(self.update(60, "coding", "stuck")["state"], "stuck")

    def test_away_and_meeting_take_effect_at_once_both_ways(self):
        self.update(0, "coding")
        self.assertEqual(self.update(1, "away")["mode"], "away")
        self.assertEqual(self.update(2, "coding")["mode"], "coding")
        self.assertEqual(self.update(3, "meeting")["mode"], "meeting")
        self.assertEqual(self.update(4, "reading")["mode"], "reading")
        self.assertEqual([row[1] for row in self.logged], ["coding", "away", "coding", "meeting", "reading"])

    def test_before_away_is_the_last_result_in_effect_before_user_nows_absence(self):
        absence = {"id": "1-1", "since": T0 + 15}
        self.assertIsNone(self.update(0, "coding", "stuck", thread="Endfield", blocker="error: x")["before_away"])
        self.update(10, "coding", "stuck", thread="Endfield", blocker="error: x")
        self.assertIsNone(self.update(15, "away")["before_away"])  # the scene's away alone is no absence
        away = self.update(20, "away", absence=absence)
        self.assertEqual(away["before_away"], {**derived("coding", "stuck", thread="Endfield", blocker="error: x"),
                                               "ts": T0 + 10})
        self.setUp()
        self.update(10, "coding", "stuck", thread="Endfield", blocker="error: x")
        away = self.update(20, "coding", "stuck", absence=absence)
        self.assertEqual(away["before_away"], {**derived("coding", "stuck", thread="Endfield", blocker="error: x"),
                                               "ts": T0 + 10})
        self.update(500, "away", absence=absence)
        back = self.update(1000, "reading")
        self.assertEqual((back["mode"], back["before_away"]["mode"], back["before_away"]["ts"]),
                         ("reading", "coding", T0 + 10))
        self.update(1100, "reading", absence={"id": "1-2", "since": T0 + 1050})
        self.assertEqual(self.update(1200, "away", absence={"id": "1-2", "since": T0 + 1050})["before_away"]["ts"],
                         T0 + 1000)

    def test_a_correction_takes_effect_at_once(self):
        self.update(0, "coding")
        self.assertEqual(self.state.update(derived("reading"), T0 + 5, at_once=True)["mode"], "reading")

    def test_clear_forgets_every_result(self):
        self.update(0, "coding", "stuck", blocker="error: x")
        self.assertIsNotNone(self.update(20, "away", absence={"id": "1-1", "since": T0 + 10})["before_away"])
        self.state.clear()
        result = self.update(21, "reading")
        self.assertEqual((result["mode"], result["before_away"]), ("reading", None))

    def test_thread_and_on_mind_follow_the_latest_derivation(self):
        self.update(0, "coding")
        mind = {"text": "foo", "source": "field", "ts": T0 + 4}
        result = self.update(5, "reading", thread="repo", on_mind=mind)
        self.assertEqual((result["mode"], result["thread"], result["on_mind"]), ("coding", "repo", mind))


class JudgmentTest(unittest.TestCase):
    def judgment(self, mode="reading", state="flowing", confidence=0.8, ago=10.0):
        return {"mode": mode, "state": state, "on_mind": "读文档", "confidence": confidence, "ts": T0 - ago}

    def test_needs_judgment(self):
        for mode, state, expected in (("coding", "unknown", True), ("other", "flowing", True), ("other", "unknown", True),
                                      ("coding", "stuck", False), ("reading", "idle", False),
                                      ("away", "unknown", False), ("meeting", "unknown", False)):
            with self.subTest(mode=mode, state=state):
                self.assertEqual(user_state.needs_judgment(derived(mode, state)), expected)

    def test_apply_judgment(self):
        base = derived("other", "unknown", evidence=["x"])
        apply = lambda d, j: user_state.apply_judgment(d, j, T0)  # noqa: E731
        self.assertIs(apply(base, None), base)
        self.assertIs(apply(base, self.judgment(ago=user_state.JUDGE_FRESH + 1)), base)
        self.assertIs(apply(base, self.judgment(confidence=user_state.JUDGE_CONFIDENCE - 0.01)), base)
        fresh = apply(base, self.judgment())
        self.assertEqual((fresh["mode"], fresh["state"], fresh["evidence"], fresh["on_mind"]),
                         ("reading", "flowing", ["x", "character_agent"], None))
        self.assertEqual(base["evidence"], ["x"])
        only_state = apply(derived("coding"), self.judgment())
        self.assertEqual((only_state["mode"], only_state["state"], only_state["evidence"]),
                         ("coding", "flowing", ["character_agent"]))
        only_mode = apply(derived("other", "idle"), self.judgment(mode="writing", state="unknown"))
        self.assertEqual((only_mode["mode"], only_mode["state"], only_mode["evidence"]),
                         ("writing", "idle", ["character_agent"]))
        for judged in (self.judgment(mode="away", state="unknown"), self.judgment(mode="meeting", state="unknown")):
            with self.subTest(judged["mode"]):
                same = apply(derived("other", "idle"), judged)
                self.assertEqual((same["mode"], same["evidence"]), ("other", []))
        away = derived("away")
        self.assertIs(apply(away, self.judgment()), away)
        unchanged = apply(derived("coding", "stuck"), self.judgment())
        self.assertEqual((unchanged["state"], unchanged["evidence"]), ("stuck", []))


class NamesTest(unittest.TestCase):
    def test_every_mode_state_and_source_has_a_name(self):
        self.assertEqual(set(user_state.MODE_NAMES), set(user_state.MODES))
        self.assertIsNone(re.search(r"[㐀-鿿]", "".join(user_state.MODE_NAMES.values())))  # they go into English prompts

    def test_judge_instructions_are_english_and_name_every_mode_and_state(self):
        text = user_state.JUDGE_INSTRUCTIONS
        self.assertIsNone(re.search(r"[㐀-鿿]", text))
        for name in user_state.MODES + user_state.STATES:
            self.assertIn(f"{name} = ", text)


if __name__ == "__main__":
    unittest.main()
