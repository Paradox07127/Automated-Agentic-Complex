from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character import behavior  # noqa: E402
from character.behavior import ACTIVITIES, MOODS, Behavior, category, prompt  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from infra.store import open_store  # noqa: E402

T0 = 1792300000.0
NOON = time.mktime((2026, 10, 19, 12, 0, 0, 0, 0, -1))


def sit(**over):
    return {"hour": 14, "focus_state": "idle", "pending": 0, "presence": "active", "presence_s": 30.0,
            "category": "coding", **over}


class FakeModel:
    def __init__(self, *answers):
        self.answers, self.prompts = list(answers), []

    def choose(self, text):
        self.prompts.append(text)
        return self.answers.pop(0) if self.answers else {"activity": "relax", "mood": "normal"}


class BehaviorTest(unittest.TestCase):
    def setUp(self):
        self.now, self.state, self.emitted, self.speaking = T0, sit(), [], False

    def make(self, model=None):
        return Behavior(lambda: self.state, lambda a, m: self.emitted.append((a, m)), backend=model,
                        clock=lambda: self.now, speaking=lambda: self.speaking)

    def step(self, b, seconds=behavior.TICK, **over):
        self.now += seconds
        self.state = sit(**over)
        b.tick()

    def test_rules_pick_from_the_situation(self):
        cases = [({}, "relax"), ({"presence": "afk", "presence_s": 60.0}, "idle"),
                 ({"presence": "afk", "presence_s": behavior.SLEEP_AFTER}, "sleep"),
                 ({"pending": 1}, "wait"), ({"focus_state": "running_tool"}, "think"),
                 ({"hour": 23}, "yawn")]
        for over, expected in cases:
            with self.subTest(over=over):
                self.emitted = []
                b = self.make()
                self.step(b, **over)
                self.assertEqual(self.emitted[-1][0], expected)

    def test_react_and_fidget(self):
        b = self.make()
        self.step(b)
        b.event("dispatch_failed")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "sad"))
        self.step(b, presence="afk", presence_s=600.0)
        self.step(b)
        self.assertEqual(self.emitted[-1][0], "relax")
        self.step(b, behavior.FIDGET_AFTER)
        self.assertEqual(self.emitted[-1][0], "fidget")

    def test_model_value_outside_the_set_falls_back_to_rules(self):
        model = FakeModel({"activity": "dance", "mood": "normal"}, {"activity": "think", "mood": "angry"})
        b = self.make(model)
        self.step(b, presence="afk", presence_s=60.0)
        self.assertEqual(self.emitted[-1], ("idle", "normal"))
        self.step(b, behavior.MODEL_EVERY, presence="afk", presence_s=60.0, category="reading")
        self.assertEqual(self.emitted[-1], ("idle", "normal"))
        self.assertEqual(len(model.prompts), 2)
        for activity, mood in self.emitted:
            self.assertIn(activity, ACTIVITIES)
            self.assertIn(mood, MOODS)

    def test_hard_conditions_win_over_the_model(self):
        cases = [({"hour": 23, "presence": "afk", "presence_s": 900.0}, "sleep"), ({"pending": 1}, "wait"),
                 ({"focus_state": "running_tool"}, "think")]
        for over, expected in cases:
            with self.subTest(over=over):
                self.emitted = []
                model = FakeModel({"activity": "yawn", "mood": "normal"})
                b = self.make(model)
                self.step(b, **over)
                self.assertEqual(self.emitted[-1][0], expected)
                self.assertEqual(model.prompts, [])  # no model call spent on a settled tick
        # Without their hard conditions the model may not pick sleep, wait or think either.
        for activity in ("sleep", "wait", "think"):
            with self.subTest(activity=activity):
                self.emitted = []
                b = self.make(FakeModel({"activity": activity, "mood": "normal"}))
                self.step(b)
                self.assertEqual(self.emitted[-1], ("relax", "normal"))
        # Control: with no hard condition the model's pick stands.
        self.emitted = []
        b = self.make(FakeModel({"activity": "yawn", "mood": "normal"}))
        self.step(b)
        self.assertEqual(self.emitted[-1][0], "yawn")

    def test_no_one_shot_twice_in_a_row_and_fidget_only_from_relax(self):
        model = FakeModel(*[{"activity": "fidget", "mood": "normal"}] * 4)
        b = self.make(model)
        self.step(b, presence="afk", presence_s=60.0)  # idle: fidget is not allowed here
        self.assertEqual(self.emitted[-1][0], "idle")
        self.step(b, behavior.MODEL_EVERY)
        self.assertEqual(self.emitted[-1][0], "relax")
        self.step(b, behavior.MODEL_EVERY)
        self.assertEqual(self.emitted[-1][0], "fidget")
        self.step(b, behavior.MODEL_EVERY)
        self.assertEqual(self.emitted[-1][0], "relax")  # not a second fidget
        for previous, current in zip(self.emitted, self.emitted[1:]):
            self.assertNotEqual(previous, current)

    def test_one_shot_is_dropped_while_speaking(self):
        b = self.make()
        self.step(b)
        b.event("dispatch_done")
        self.speaking = True
        self.step(b, 5)
        self.assertEqual(self.emitted, [("relax", "normal")])
        self.speaking = False
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "happy"))

    def test_session_done_reacts_happy_once(self):
        b = self.make()
        self.step(b)
        b.event("session_done")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "happy"))
        self.step(b, 5)
        b.event("session_done")  # another turn ends within EVENT_FRESH of the first
        self.step(b, 5)
        self.assertEqual(self.emitted[-2:], [("react", "happy"), ("relax", "normal")])
        self.now += behavior.EVENT_FRESH
        b.event("session_done")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "happy"))

    def test_her_job_ends_react_once_per_event_fresh(self):
        b = self.make()
        self.step(b)
        b.event("job_done")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "happy"))
        self.step(b, 5)
        b.event("job_done")  # another job ends within EVENT_FRESH of the first
        self.step(b, 5)
        self.assertEqual(self.emitted[-2:], [("react", "happy"), ("relax", "normal")])
        self.now += behavior.EVENT_FRESH
        b.event("job_failed")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "sad"))

    def test_session_error_reacts_sad(self):
        b = self.make()
        self.step(b)
        b.event("session_error")
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "sad"))

    def busy(self, b, seconds, **over):
        """A tick `seconds` into a busy stretch of her session that began at T0 without a break; thinking, so no long
        tool run raises a guard (test_routine)."""
        self.now = T0 + seconds
        self.state = sit(focus_state="thinking", busy_since=T0, **over)
        b.tick()

    def test_guard_while_gaming(self):
        model = FakeModel({"activity": "relax", "mood": "normal"})
        b = self.make(model)
        self.step(b, scene="gaming")
        self.assertEqual(self.emitted[-1][0], "guard")
        self.assertEqual(model.prompts, [])  # only the rules pick guard
        b = self.make()
        self.step(b, scene="gaming", presence="afk", presence_s=60.0)
        self.assertEqual(self.emitted[-1][0], "idle")
        # Without their conditions the model may not pick guard or fly either.
        for activity in ("guard", "fly"):
            with self.subTest(activity=activity):
                b = self.make(FakeModel({"activity": activity, "mood": "normal"}))
                self.step(b)
                self.assertEqual(self.emitted[-1], ("relax", "normal"))

    def test_fly_is_rare_think_while_busy(self):
        b = self.make()
        fly, ended = behavior.FLY_AFTER, behavior.FLY_AFTER + 20 + behavior.FLY_LONGEST + 5
        self.busy(b, 60)
        self.assertEqual(self.emitted[-1][0], "think")
        self.busy(b, fly - 1)
        self.assertEqual(self.emitted[-1][0], "think")
        self.busy(b, fly + 20)
        self.assertEqual(self.emitted[-1][0], "fly")
        self.busy(b, ended)  # a fly of FLY_LONGEST + 5 s ends while the session is still busy
        self.assertEqual(self.emitted[-1][0], "think")
        self.busy(b, ended + behavior.FLY_GAP - 1)
        self.assertEqual(self.emitted[-1][0], "think")
        self.busy(b, ended + behavior.FLY_GAP)
        self.assertEqual(self.emitted[-1][0], "fly")

    def test_the_poll_ends_a_long_fly(self):
        b = self.make()
        for seconds, expected in ((200, "fly"), (289, "fly"), (290, "think"), (295, "think")):
            with self.subTest(seconds=seconds):
                self.now = T0 + seconds
                self.state = sit(focus_state="running_tool", busy_since=T0)
                b.poll()
                self.assertEqual(self.emitted[-1][0], expected)

    def test_her_own_job_is_think_and_never_fly(self):
        model = FakeModel({"activity": "relax", "mood": "normal"})
        b = self.make(model)
        self.step(b)
        self.assertEqual(self.emitted[-1][0], "relax")
        asked = len(model.prompts)
        self.now += behavior.MODEL_EVERY
        self.state = sit(own_job=True)
        b.poll()
        self.assertEqual(self.emitted[-1][0], "think")
        self.now += behavior.FLY_AFTER + behavior.POLL
        b.poll()
        self.assertEqual(self.emitted[-1][0], "think")
        self.assertEqual(len(model.prompts), asked)  # only the rules pick think
        self.now += behavior.POLL
        self.state = sit()
        b.poll()
        self.assertEqual(self.emitted[-1][0], "relax")

    def test_no_fly_in_the_no_interrupt_zone_or_away(self):
        for over in ({"meeting": True}, {"fullscreen": True}, {"typing": True},
                     {"presence": "afk", "presence_s": 60.0}):
            with self.subTest(over=over):
                self.emitted = []
                b = self.make()
                self.busy(b, behavior.FLY_AFTER + 10, **over)
                self.assertEqual(self.emitted[-1][0], "think")
                self.busy(b, behavior.FLY_AFTER + 15)
                self.assertEqual(self.emitted[-1][0], "fly")

    def test_wait_wins_over_fly(self):
        b = self.make()
        self.busy(b, behavior.FLY_AFTER + 5)
        self.assertEqual(self.emitted[-1][0], "fly")
        self.busy(b, behavior.FLY_AFTER + 10, pending=1)
        self.assertEqual(self.emitted[-1][0], "wait")

    def test_fly_ends_when_the_session_goes_idle(self):
        b = self.make()
        self.busy(b, behavior.FLY_AFTER + 5)
        self.assertEqual(self.emitted[-1][0], "fly")
        self.now += behavior.POLL
        self.state = sit()
        b.poll()
        self.assertEqual(self.emitted[-1][0], "relax")

    def test_the_poll_starts_and_ends_fly_and_guard_at_the_next_check(self):
        b = self.make()
        fly, gap = behavior.FLY_AFTER, behavior.FLY_GAP
        steps = ((5, {}, "think"), (fly + 5, {}, "fly"), (fly + 10, {"fullscreen": True}, "think"),
                 (fly + 15, {}, "think"), (fly + 10 + gap, {}, "fly"),
                 (fly + 15 + gap, {"typing": True}, "think"))
        for seconds, over, expected in steps:
            with self.subTest(seconds=seconds):
                self.now = T0 + seconds
                self.state = sit(focus_state="thinking", busy_since=T0, **over)
                b.poll()
                self.assertEqual(self.emitted[-1][0], expected)
        self.now += behavior.POLL
        self.state = sit()
        b.poll()
        self.assertEqual(self.emitted[-1][0], "relax")
        self.now += behavior.POLL
        self.state = sit(scene="gaming")
        b.poll()
        self.assertEqual(self.emitted[-1][0], "guard")

    def test_model_is_called_at_most_once_per_interval(self):
        model = FakeModel()
        b = self.make(model)
        for _ in range(100):
            self.step(b, behavior.POLL, focus_state="thinking" if len(self.emitted) % 2 else "idle")
        self.assertLessEqual(len(model.prompts), 100 * behavior.POLL / behavior.MODEL_EVERY + 1)

    def test_unchanged_background_scene_reuses_semantics_for_fifteen_minutes(self):
        model = FakeModel()
        b = self.make(model)
        for _ in range(20):
            self.step(b, behavior.MODEL_EVERY)
        self.assertEqual(len(model.prompts), 4)  # calls at 180, 1080, 1980, 2880 s
        self.step(b, behavior.MODEL_EVERY, category="reading")
        self.assertEqual(len(model.prompts), 5, "a semantic change may be reconsidered after the minimum gap")

    def test_a_slow_model_does_not_delay_an_announce_event(self):
        started, release = threading.Event(), threading.Event()

        class SlowModel(FakeModel):
            def choose(self, text):
                started.set()
                release.wait(5)
                return super().choose(text)

        b = self.make(SlowModel())
        ticking = threading.Thread(target=b.tick)
        ticking.start()
        self.assertTrue(started.wait(2))
        t = time.monotonic()
        b.event("dispatch_done")
        waited = time.monotonic() - t
        release.set()
        ticking.join(5)
        self.assertLess(waited, 0.5)

    def test_model_result_is_discarded_when_the_scene_or_character_changes(self):
        for changed in ("scene", "character"):
            with self.subTest(changed=changed):
                self.setUp()
                generation = [0]
                outer = self
                class ChangedModel(FakeModel):
                    def choose(self, text):
                        if changed == "scene":
                            outer.state = sit(pending=1)
                        else:
                            generation[0] += 1
                        return {"activity": "yawn", "mood": "happy", "walk": "more"}
                b = Behavior(lambda: self.state, lambda a, m: self.emitted.append((a, m)),
                             backend=ChangedModel(), clock=lambda: self.now, version=lambda: generation[0])
                decisions = []
                b.on_decision = lambda kind, attrs, key: decisions.append(attrs)
                b.walk_hint, b._walk_version = ("more", self.now), generation[0]
                b.tick()
                self.assertEqual(self.emitted[-1], ("wait" if changed == "scene" else "relax", "normal"))
                self.assertEqual(b.walk_bias(), "normal")
                self.assertEqual(decisions[-1]["reason"], "stale_result")

    def test_prompt_has_the_category_never_the_title(self):
        window = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "title": "SECRET-TITLE"}
        text = prompt(sit(category=category(window)), [])
        self.assertNotIn("SECRET-TITLE", text)
        self.assertIn(behavior.CATEGORY_NAMES["coding"], text)  # control: the category is there
        self.assertEqual(category(None), "other")

    def test_prompt_names_every_session_state(self):
        from sessions.registry import STATES
        for state in STATES:
            with self.subTest(state=state):
                self.assertIn(behavior.STATE_NAMES[state], prompt(sit(focus_state=state), []))

    def test_category_falls_back_to_lsapplicationcategory(self):
        app = lambda kind: {"bundle_id": "com.example.app", "category": f"public.app-category.{kind}"}
        self.assertEqual([category(app(k)) for k in ("developer-tools", "games", "action-games", "video",
                                                    "entertainment", "music", "finance")],
                         ["coding", "game", "game", "media", "media", "media", "other"])
        # The bundle table wins over what the app declares.
        self.assertEqual(category({"bundle_id": "com.microsoft.VSCode", "category": "public.app-category.games"}),
                         "coding")
        self.assertEqual(category({"bundle_id": "com.example.app"}), "other")
        self.assertIn("game", behavior.CATEGORY_NAMES)

    def test_windows_app_ids_have_the_same_categories(self):
        # The Windows helper's app_id (a lower-case exe name or a packaged app's AUMID) arrives as bundle_id, with no category.
        cases = {"code.exe": "coding", "chrome.exe": "browsing", "windowsterminal.exe": "terminal",
                 "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App": "terminal", "MSTeams_8wekyb3d8bbwe!MSTeams": "meeting",
                 "WINWORD.EXE": "writing", "explorer.exe": "files", "notepad.exe": "other"}
        for app_id, expected in cases.items():
            with self.subTest(app_id=app_id):
                self.assertEqual(category({"bundle_id": app_id, "category": None}), expected)
        self.assertTrue(set(behavior.WINDOWS_CATEGORIES.values()) <= set(behavior.CATEGORY_NAMES))

    def test_each_tick_is_reported_with_its_options_and_reason(self):
        seen = []
        b = self.make(FakeModel({"activity": "yawn", "mood": "normal"}))
        b.on_decision = lambda kind, attrs, key: seen.append((kind, attrs, key))
        self.step(b)
        self.step(b, 5, pending=1)
        b.event("dispatch_done")
        self.speaking = True
        self.step(b, 5)
        [(kind, model, key), (_, hard, _), (_, dropped, _)] = seen
        self.assertEqual((kind, model["options"], model["chosen"], model["reason"]),
                         ("behavior.ticked", ["yawn", "relax"], "yawn", "model"))
        self.assertEqual((hard["options"], hard["chosen"], hard["reason"]), (["wait"], "wait", "hard_rule"))
        self.assertEqual((dropped["chosen"], dropped["reason"]), (None, "speaking"))
        self.assertRegex(key, r"^[0-9a-f]{16}$")

    def test_an_unchanged_tick_is_recorded_once_per_record_again(self):
        seen, applied = [], []
        b = self.make()
        b.on_decision = lambda kind, attrs, key: seen.append(attrs["chosen"])
        apply = b._apply
        b._apply = lambda choice, now: (applied.append(choice[0]), apply(choice, now))
        for _ in range(3):
            self.step(b, pending=1)
        self.assertEqual(seen, ["wait"])
        self.step(b)
        self.step(b, pending=1)
        self.assertEqual(seen, ["wait", "relax", "wait"])
        self.step(b, behavior.RECORD_AGAIN - 1, pending=1)
        self.assertEqual(len(seen), 3)
        self.step(b, 1, pending=1)
        self.assertEqual(seen, ["wait", "relax", "wait", "wait"])
        self.assertEqual(applied, ["wait"] * 3 + ["relax"] + ["wait"] * 3)  # every tick still decides
        self.assertEqual(self.emitted, [("wait", "normal"), ("relax", "normal"), ("wait", "normal")])

    def test_the_model_walk_hint_holds_until_it_goes_stale(self):
        b = self.make(FakeModel({"activity": "relax", "mood": "normal", "walk": "stay"}))
        self.step(b)
        self.assertEqual(b.walk_bias(), "stay")
        self.now += 2 * behavior.MODEL_EVERY + 1  # no model tick since
        self.assertEqual(b.walk_bias(), "normal")

    def test_an_unknown_walk_value_falls_back_to_normal(self):
        for answer in ({"activity": "relax", "mood": "normal", "walk": "run"},
                       {"activity": "relax", "mood": "normal"}, {"activity": "dance", "mood": "normal", "walk": 1}):
            with self.subTest(answer=answer):
                b = self.make(FakeModel(answer))
                self.step(b)
                self.assertEqual(b.walk_bias(), "normal")

    def test_no_backend_means_normal(self):
        b = self.make()
        self.assertEqual(b.walk_bias(), "normal")
        self.step(b)
        self.assertEqual(b.walk_bias(), "normal")

    def test_a_failing_decision_callback_changes_nothing(self):
        b = self.make()
        b.on_decision = lambda *_: 1 / 0
        self.step(b)
        self.assertEqual(self.emitted, [("relax", "normal")])

    def test_a_return_is_no_activity(self):
        self.assertNotIn("welcome_back", behavior.ACTIVITIES)
        self.assertNotIn("welcome_small", behavior.ACTIVITIES)
        model = FakeModel({"activity": "welcome_back", "mood": "happy"})
        b = self.make(model)
        self.step(b)
        self.assertEqual(self.emitted[-1][0], "relax")


class StateTest(unittest.TestCase):
    """The behavior tick under her own state; the clock is noon, the situation's hour 14 (outside YAWN_HOURS)."""
    step = BehaviorTest.step

    def setUp(self):
        self.now, self.state, self.emitted, self.speaking = NOON, sit(), [], False

    def stated(self, profile=None, model=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        state = CharacterState(db, {"aster": profile}.get, clock=lambda: self.now)
        state.use("aster")
        b = Behavior(lambda: self.state, lambda a, m: self.emitted.append((a, m)), backend=model,
                     clock=lambda: self.now, speaking=lambda: self.speaking, state=state)
        return state, b

    def test_state_affects_off_keeps_background_model_and_rules_running(self):
        from types import SimpleNamespace
        from daemon.agentd_server import StateView
        state, b = self.stated(model=FakeModel())
        b.state = StateView(SimpleNamespace(state=state, state_affects=False))
        self.step(b)
        self.assertEqual(self.emitted[-1], ("relax", "normal"))
        self.assertEqual(len(b.backend.prompts), 1)
        self.step(b, behavior.MODEL_EVERY)
        self.assertEqual(len(b.backend.prompts), 1)

    def test_sustained_mood_is_happy_after_a_done_and_never_sad_without_a_failure(self):
        state, b = self.stated()
        self.step(b)
        self.assertEqual(self.emitted[-1], ("relax", "normal"))
        for kind in ("dispatch_done", "session_done", "dispatch_done"):
            state.on_event(kind)  # 0.2 -> 0.6, past the baseline + MOOD_OFF
        self.step(b, 5, pending=1)
        self.assertEqual(self.emitted[-1], ("wait", "happy"))
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("relax", "happy"))
        for _ in range(40):  # an hour: the mood goes back to the baseline
            self.step(b)
        self.assertEqual([m for a, m in self.emitted if a == "relax"][-1], "normal")
        self.assertNotIn("sad", [m for _, m in self.emitted])
        b.event("dispatch_failed")  # control: a failure still makes her sad
        self.step(b, 5)
        self.assertEqual(self.emitted[-1], ("react", "sad"))

    def test_a_tired_character_yawns_outside_the_yawn_hours_once_per_gap(self):
        # energy_offset -0.5: noon pulls energy to 0.3, under 0.35
        for profile, yawns, afk in (({"energy_offset": -0.5}, 2, "sleep"), (None, 0, "idle")):
            with self.subTest(profile=profile):
                self.now, self.emitted = NOON, []
                _, b = self.stated(profile)
                for _ in range(40):  # an hour of ticks, 90 s apart
                    self.step(b)
                self.assertEqual([a for a, _ in self.emitted].count("yawn"), yawns)
                _, b = self.stated(profile)
                self.step(b, presence="afk", presence_s=300.0)
                self.assertEqual(self.emitted[-1][0], afk)

    def test_prompt_carries_state_labels_only(self):
        model = FakeModel()
        state, b = self.stated({"energy_offset": -0.5}, model)
        seen = []
        b.on_decision = lambda kind, attrs, key: seen.append(attrs)
        self.step(b)
        [text] = model.prompts
        labels = state.labels()
        self.assertEqual(seen[-1]["state"], labels)  # behavior.ticked carries the labels too
        self.assertEqual((labels["energy"], labels["mood"]), ("sleepy", "steady"))
        self.assertIn("The character's own state: energy a bit sleepy, mood steady.", text)
        self.assertIn("The character's own state: energy very sleepy, mood a bit low.",
                      prompt(sit(), [], {"energy": "very_sleepy", "mood": "low"}))
        self.assertNotRegex(text, r"\d\.\d")  # no value, only the labels
        self.assertNotIn("own state", prompt(sit(), []))  # control: without a state the prompt is as before


class RegistryActivityTest(unittest.TestCase):
    def test_activity_and_mood_ride_on_every_intent(self):
        reg = Registry(epoch=1)
        reg.set_activity("relax", "normal")
        reg.set_activity("relax", "normal")  # unchanged: no new event
        [first] = reg.intents_since(0)
        self.assertEqual((first["activity"], first["mood"], first["intent"]), ("relax", "normal", "idle"))
        reg.set_activity("think", "happy")
        self.assertEqual([(i["activity"], i["mood"]) for i in reg.intents_since(0)],
                         [("relax", "normal"), ("think", "happy")])
        self.assertIsNone(Registry(epoch=1).snapshot()["focus"].get("activity"))


if __name__ == "__main__":
    unittest.main()
