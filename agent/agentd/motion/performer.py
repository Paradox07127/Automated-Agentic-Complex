"""A reply's [motion:...] marker as a C1 `perform` behavior: the character's game action when the text names one
(motion.catalog), else generate, retarget for the current character, store, publish. Late or failed, nothing is
published: the line's clause_intent already drives the pack's gesture.

A host's POST /motions/generate runs in a slot of its own and always answers with one C1 `motion` event."""
from functools import cached_property
import hashlib
import importlib
import json
from pathlib import Path
import secrets
import threading
import time
import uuid

from motion import catalog, requests
from motion.client import MotionClient, ServiceError
from motion.store import MotionStore

PERFORM_BUDGET = 4.0  # s from a reply's marker to the publish; the clause's authored gesture plays meanwhile
REQUEST_BUDGET = 2.5  # s: the host plays the pack's clip once a requested motion is this late (C1 §1.5)
RETARGET_RESERVE = 0.3  # s kept for retarget and store after generate: a 3 m walk's retarget takes ~0.2 s
MAX_TRAVEL_M = 0.25  # a perform whose hips end farther than this from where they began was a walk: not published
MIN_TOE_CM = -3.0  # a perform whose source toes sink deeper than this below Kimodo's ground: not published
PRIORITY = 1
HOST_WAIT = 6.0  # s the behavior outlives its clip: the host waits up to 5 s for the files before it plays
EVENT_REASONS = {"timeout": "timeout", "no_service": "no_service", "http_503": "busy"}  # others are "failed"


def request_trace(request_id):
    """The trace_id of a geometry request's steps: a stable UUID, since trace events refuse other ids."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "endfield-motion-request:" + request_id))


def live_retarget(package_root, cache_dir):
    """LiveRetarget from the app's runtime/content when it is there, else the dev checkout's agentic_complex_build."""
    from motion_tool import importer
    return importlib.import_module(importer() + ".live_motion").LiveRetarget(package_root, cache_dir)


def _ms(start, end):
    return max(0, round((end - start) * 1000))


class Performer:
    def __init__(self, settings, publish, package_root, cache_dir, trace=lambda kind, trace_id, **fields: None,
                 client=None, store=None, retarget=live_retarget, clock=time.monotonic,
                 perform_budget=PERFORM_BUDGET, request_budget=REQUEST_BUDGET):
        """settings: MotionSettings; publish(event, data): the /events publish Spatial uses; package_root() -> the
        current character's installed package root; trace(kind, trace_id, attrs=...): the trace step sink;
        retarget(package_root, cache_dir) -> a LiveRetarget."""
        self.settings, self.publish, self.package_root, self.cache_dir = settings, publish, package_root, cache_dir
        self.trace, self.clock = trace, clock
        self.perform_budget, self.request_budget = perform_budget, request_budget
        if client is not None:
            self.client = client
        self.store = store or MotionStore()
        self._retarget = retarget
        self._retargets = {}  # (package root, service URL) -> its LiveRetarget, fed that service's skeleton
        self._gesture_cache = (None, {})  # (package root, catalog.load of it): the current character's game gestures
        self._pending = None  # the next motion to run: (prompt, seconds, generation, trace_id, began, trace texts)
        self._busy = False  # the worker thread runs
        self._requests = {}  # behavior_id -> its waiting geometry job (request, began), oldest first
        self._requesting = False  # the geometry worker thread runs
        self._lock = threading.Lock()
        self._fit_lock = threading.Lock()  # the worker and prewarm both build LiveRetargets; a fit takes ~10 s

    @cached_property
    def client(self):
        return MotionClient()

    def start(self, prompt, seconds, generation, trace_id, remember=True):
        """Publishes the character's game gesture the prompt names at once; any other motion runs on the worker
        thread, one at a time, a newer one replacing one still waiting. remember False (「这一轮不记」): its traces
        leave the prompt out."""
        texts = {"prompt": prompt} if remember else {}
        hit = catalog.match(prompt, seconds, self._gestures())
        if hit is not None:
            self._play(*hit, seconds, generation, trace_id, texts)
            return
        with self._lock:
            replaced, self._pending = self._pending, (prompt, seconds, generation, trace_id, self.clock(), texts)
            busy, self._busy = self._busy, True
        if replaced is not None:
            self.trace("motion.fallback", replaced[3], attrs={"reason": "replaced"}, texts=replaced[5])
        if not busy:
            threading.Thread(target=self._work, name="motion", daemon=True).start()

    def gesture(self, prompt, seconds, generation, trace_id, remember=True):
        """The game driver's start: publishes the character's game gesture whose phrase the prompt is; any other prompt
        is dropped."""
        hit = catalog.named(prompt, seconds, self._gestures())
        if hit is not None:
            self._play(*hit, seconds, generation, trace_id, {"prompt": prompt} if remember else {})

    def _gestures(self):
        """The current character's catalog, read again only when the package root changes; {} when it cannot be read."""
        try:
            root = Path(self.package_root())
            if self._gesture_cache[0] != root:
                self._gesture_cache = (root, catalog.load(root))
        except Exception:  # this runs on the turn's thread: an unreadable package leaves every motion to generation
            return {}
        return self._gesture_cache[1]

    def _play(self, action_id, group, length_s, seconds, generation, trace_id, texts):
        behavior = {"behavior_id": "b-ga-" + secrets.token_hex(8), "type": "perform", "target": None,
                    "trigger": {"source": "agent", "event": None}, "display_session": None, "turn_id": None,
                    "turn_generation": generation, "priority": PRIORITY,
                    "expires_at_ms": int((time.time() + length_s + HOST_WAIT) * 1000), "intensity": 1.0,
                    "channels": ["full_body"], "exit": [], "replaces": None, "trace_id": trace_id,
                    "action": {"id": action_id, "length_s": length_s}}
        self.publish("behavior", behavior)
        self.trace("motion.matched", trace_id,
                   attrs={"action_id": action_id, "group": group, "length_s": length_s, "seconds": seconds},
                   texts=texts)

    def request(self, body):
        """Runs a checked POST /motions/generate body on the geometry thread; a newer request for the same
        behavior_id replaces one still waiting, which is answered busy."""
        with self._lock:
            replaced = self._requests.pop(body["behavior_id"], None)
            self._requests[body["behavior_id"]] = (body, self.clock())
            busy, self._requesting = self._requesting, True
        if replaced is not None:
            self.trace("motion.fallback", request_trace(replaced[0]["request_id"]), attrs={"reason": "replaced"})
            self._answer(replaced[0], {"ok": False, "reason": "busy"})
        if not busy:
            threading.Thread(target=self._work_requests, name="motion-requests", daemon=True).start()

    def _work_requests(self):
        while True:
            with self._lock:
                if not self._requests:
                    self._requesting = False
                    return
                job = self._requests.pop(next(iter(self._requests)))
            self._generate(*job)

    def refuse(self, body, reason):
        """A checked request this backend does not generate: its failed motion event at once."""
        self._answer(body, {"ok": False, "reason": reason})

    def _answer(self, body, fields):
        self.publish("motion", {"request_id": body["request_id"], "behavior_id": body["behavior_id"], **fields})

    def _work(self):
        while True:
            with self._lock:
                job, self._pending = self._pending, None
                if job is None:
                    self._busy = False
                    return
            self._perform(*job)

    def _in_time(self, began, budget):
        if self.clock() - began > budget:
            raise ServiceError("timeout")

    def _generate_timeout(self, began, budget):
        """The service's share of the budget left: what remains less RETARGET_RESERVE."""
        left = budget - (self.clock() - began) - RETARGET_RESERVE
        if left <= 0:
            raise ServiceError("timeout")
        return left

    def _retarget_for(self, root, url, token):
        key = (root, url)
        with self._fit_lock:
            if key not in self._retargets:
                retarget = self._retarget(root, self.cache_dir)
                retarget.skeleton(self.client.skeleton(url, token))
                self._retargets[key] = retarget
            return self._retargets[key]

    def prewarm(self, driver):
        """With driver (the current character's effective motion driver) generated, builds the current character's
        LiveRetarget on a thread so the first motion meets the budget. A failure here is reported by the first motion
        that hits it."""
        url, token = self.settings.endpoint()
        if driver != "generated" or url is None:
            return
        def run():
            try:
                self._retarget_for(Path(self.package_root()), url, token)
            except Exception:
                pass
        threading.Thread(target=run, name="motion-prewarm", daemon=True).start()

    def _perform(self, prompt, seconds, generation, trace_id, began, texts):
        stage = "generate"
        try:
            url, token = self.settings.endpoint()
            if url is None:
                raise ServiceError("no_service")
            called = self.clock()
            npz = self.client.generate(url, token, prompt, seconds, timeout=self._generate_timeout(began, self.perform_budget))
            generated = self.clock()
            self._in_time(began, self.perform_budget)
            stage = "retarget"
            retarget = self._retarget_for(Path(self.package_root()), url, token)
            motion_id = "gm-" + secrets.token_hex(8)
            meta, keys, _ = retarget.clip(npz, motion_id)
            retargeted = self.clock()
            self._in_time(began, self.perform_budget)
            quality = meta["curve_provenance"]["quality"]
            checks = [name for name, failed in (("travel", quality["removed_travel_m"] > MAX_TRAVEL_M),
                                                ("floor", quality["toe_min_cm"] < MIN_TOE_CM)) if failed]
            if checks:
                self.trace("motion.fallback", trace_id,
                           attrs={"reason": "quality", "checks": checks, "removed_travel_m": quality["removed_travel_m"],
                                  "toe_min_cm": quality["toe_min_cm"], "total_ms": _ms(began, self.clock())},
                           texts=texts)
                return
            meta_bytes = json.dumps(meta).encode()
            self.store.put(motion_id, meta_bytes, keys)
            behavior = {"behavior_id": f"b-{motion_id}", "type": "perform", "target": None,
                        "trigger": {"source": "agent", "event": None}, "display_session": None, "turn_id": None,
                        "turn_generation": generation, "priority": PRIORITY,
                        "expires_at_ms": int((time.time() + meta["length"] + HOST_WAIT) * 1000), "intensity": 1.0,
                        "channels": ["full_body"], "exit": [], "replaces": None, "trace_id": trace_id,
                        "motion": {"id": motion_id, "meta_sha256": hashlib.sha256(meta_bytes).hexdigest(),
                                   "keys_sha256": hashlib.sha256(keys).hexdigest(),
                                   "rig_sha256": retarget.rig_sha256, "length_s": meta["length"]}}
            self.publish("behavior", behavior)
        except Exception as error:  # the pack's gesture stands in for any failure
            reason = error.reason if isinstance(error, ServiceError) else f"{stage}_failed"
            self.trace("motion.fallback", trace_id, attrs={"reason": reason, "total_ms": _ms(began, self.clock())},
                       texts=texts)
            return
        self.trace("motion.published", trace_id,
                   attrs={"motion_id": motion_id, "behavior_id": behavior["behavior_id"],
                          "generate_ms": _ms(called, generated), "retarget_ms": _ms(generated, retargeted),
                          "total_ms": _ms(began, self.clock())}, texts=texts)

    def _generate(self, body, began):
        stage, trace_id, checked = "retarget", request_trace(body["request_id"]), {}
        try:
            self._in_time(began, self.request_budget)
            url, token = self.settings.endpoint()
            if url is None:
                raise ServiceError("no_service")
            retarget = self._retarget_for(Path(self.package_root()), url, token)
            prompt, constraints = requests.build(body["kind"], body["seconds"], body["geometry"], retarget.to_kimodo)
            stage = "generate"
            called = self.clock()
            npz = self.client.generate(url, token, prompt, body["seconds"], constraints=constraints,
                                       timeout=self._generate_timeout(began, self.request_budget))
            generated = self.clock()
            self._in_time(began, self.request_budget)
            headed = body["kind"] in requests.HEADED
            problems = requests.heading_problems(body["kind"], body["seconds"], constraints, retarget.heading(npz)) if headed else []
            checked = {"retried": False, "problems": problems} if headed else {}
            # Once, with the service's own seed, when the budget left fits another generate as slow as this one.
            if problems and self.request_budget - (self.clock() - began) - RETARGET_RESERVE >= 1.2 * (generated - called):
                checked["retried"] = True
                npz = self.client.generate(url, token, prompt, body["seconds"], constraints=constraints,
                                           timeout=self._generate_timeout(began, self.request_budget))
                generated = self.clock()
                self._in_time(began, self.request_budget)
                problems = requests.heading_problems(body["kind"], body["seconds"], constraints, retarget.heading(npz))
                # The trace keeps the first try's problems when the second passes.
                checked["problems"] = problems or checked["problems"]
            if problems:
                raise ServiceError("off_heading")
            stage = "retarget"
            motion_id = "gm-" + secrets.token_hex(8)
            meta, keys, tracks = retarget.clip(npz, motion_id, body["kind"], geometry=body["geometry"])
            retargeted = self.clock()
            self._in_time(began, self.request_budget)
            meta_bytes, tracks_bytes = json.dumps(meta).encode(), json.dumps(tracks).encode()
            self.store.put(motion_id, meta_bytes, keys, tracks_bytes)
            self._answer(body, {"ok": True, "motion": {
                "id": motion_id, "meta_sha256": hashlib.sha256(meta_bytes).hexdigest(),
                "keys_sha256": hashlib.sha256(keys).hexdigest(), "rig_sha256": retarget.rig_sha256,
                "length_s": meta["length"], "tracks_sha256": hashlib.sha256(tracks_bytes).hexdigest()}})
        except Exception as error:  # the host plays the pack's clips for any failure
            reason = error.reason if isinstance(error, ServiceError) else f"{stage}_failed"
            self._answer(body, {"ok": False, "reason": EVENT_REASONS.get(reason, "failed")})
            self.trace("motion.fallback", trace_id,
                       attrs={"reason": reason, **checked, "total_ms": _ms(began, self.clock())})
            return
        self.trace("motion.published", trace_id,
                   attrs={"motion_id": motion_id, "behavior_id": body["behavior_id"], **checked,
                          "generate_ms": _ms(called, generated), "retarget_ms": _ms(generated, retargeted),
                          "total_ms": _ms(began, self.clock())})
