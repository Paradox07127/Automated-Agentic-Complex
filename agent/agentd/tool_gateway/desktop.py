"""agentd's side of Companion's per-session desktop grant. The only constructor of ComputerControlClient."""
import threading
import time

from tool_gateway.computer_use import ComputerControlClient, ComputerUseError

# Ends that revoke without the panel showing 「任务已取消」; every other reason cancels.
RELEASE_REASONS = frozenset({"run_end", "shutdown", "own_idle", "own_turn_end", "conversation_idle",
                             "conversation_switch"})
ACQUIRE_WAIT = 3.0  # seconds a new lease waits for releases still in flight
IDLE_RELEASE = 120.0  # seconds; the same as the control-grant window, reused per conversation


def _revoke(config, session_id, reason, timeout):
    method = "desktop_release" if reason in RELEASE_REASONS else "desktop_cancel"
    try:
        ComputerControlClient(config, session_id, timeout=timeout).call(method, {})
    except ComputerUseError:
        pass  # an offline native server cannot be cancelled; do not retry or expose its credentials


def release_session(config, session_id, reason, timeout=2):
    """Revoke an own session's grant on its own socket, without delaying the caller."""
    threading.Thread(target=_revoke, args=(config, session_id, reason, timeout), daemon=True).start()


def status(config, session_id):
    return ComputerControlClient(config, session_id, timeout=3).call("desktop_status", {})


def session_client(config, session_id, mode):
    return ComputerControlClient(config, session_id, allow_control=mode == "workspace_write", timeout=195,
                                 wait_for_permission=True)


def _lease(key):
    return key.conversation_id or key.run_id


class DesktopLeases:
    """Character runs: one lease per conversation (per run_id without one), opened by its first desktop_* call."""

    def __init__(self, computer_control, egress, report, timer=threading.Timer):
        self._config, self._egress, self._report = computer_control, egress, report
        self._timer = timer
        self._lock = threading.Lock()
        self._held = {}  # lease (conversation id, or run id) -> client
        self._owner = {}  # conversation lease -> run_id that last used it
        self._runs = {}  # run_id -> SessionKey, while the run's ToolSession is open
        self._idle = {}  # conversation lease -> its pending idle-release timer
        self._releasing = set()  # an Event per release still in flight
        self._task_runs = set()  # Messages tasks must release even a conversation lease at run_end

    def enter(self, key):
        """Binds the run's calls to its conversation's lease; leases of other conversations are released."""
        with self._lock:
            self._runs[key.run_id] = key
            if key.conversation_id is None:
                stale = [self._take(lease) for lease in list(self._idle)]
            else:
                timer = self._idle.pop(key.conversation_id, None)
                if timer is not None:
                    timer.cancel()
                stale = [self._take(lease) for lease in list(self._owner) if lease != key.conversation_id]
        for client, done in stale:
            self._revoke(key.run_id, client, "conversation_switch", done)

    def computer_call(self, key, name, args, *, timeout):
        """Private Messages loop: pixels stay in memory and grants never block for renewal."""
        with self._lock:
            self._task_runs.add(key.run_id)
        return self.call(key, name, args, computer_task=True, timeout=timeout)

    def call(self, key, name, args, *, computer_task=False, timeout=None):
        task_deadline = time.monotonic() + timeout if computer_task else None
        config = self._config()
        if config is None:
            return {"error": {"code": "desktop_unavailable"}}
        # The first bridge is text/AX only. Never stringify pixels into model text.
        if args.get("include_image") and not computer_task:
            return {"error": {"code": "image_bridge_unavailable"}}
        with self._lock:
            key = self._runs.get(key.run_id, key)
            client = self._held.get(_lease(key))
            pending = None
            if client is None:
                client = self._held[_lease(key)] = ComputerControlClient(config, key.native_session,
                    allow_control=True, timeout=195, wait_for_permission=True)
                pending = list(self._releasing)
            if key.conversation_id is not None:
                self._owner[key.conversation_id] = key.run_id
        if pending is not None:
            # Companion holds one grant at a time; a release still in flight would make this run desktop_busy.
            deadline = min(time.monotonic() + ACQUIRE_WAIT, task_deadline) if computer_task else time.monotonic() + ACQUIRE_WAIT
            for done in pending:
                done.wait(max(0.0, deadline - time.monotonic()))
            self._report("desktop.lease_opened", {"run_id": key.run_id, "session_id": key.native_session}, key.run_id)
        try:
            if computer_task:
                old_timeout, old_wait = client.timeout, client.wait_for_permission
                try:
                    remaining = task_deadline - time.monotonic()
                    if remaining <= 0:
                        return {"error": {"code": "bridge_timeout", "retryable": False}}
                    client.timeout = min(10, remaining)
                    client.wait_for_permission = False
                    result = client.call(name, args)
                finally:
                    client.timeout, client.wait_for_permission = old_timeout, old_wait
            else:
                result = client.call(name, args)
        except ComputerUseError as error:
            return {"error": {"code": error.code, "retryable": False}}
        egress = self._egress()
        def clean(value):
            if isinstance(value, str):
                return egress.observed(value) if egress else value
            if isinstance(value, list):
                return [clean(item) for item in value]
            if isinstance(value, dict):
                return {k: clean(item) for k, item in value.items() if k != "image"}
            return value
        cleaned = clean(result)
        if computer_task and "image" in result:
            cleaned["image"] = result["image"]
        return cleaned

    def release(self, run_id, reason):
        """False when the run holds no lease. run_end leaves a conversation's lease to its idle timer."""
        with self._lock:
            task_run = run_id in self._task_runs
            self._task_runs.discard(run_id)
            key = self._runs.pop(run_id, None) if reason == "run_end" else self._runs.get(run_id)
            lease = _lease(key) if key else run_id
            if lease not in self._held:
                return False
            if reason == "run_end" and lease in self._owner and not task_run:
                if lease not in {_lease(other) for other in self._runs.values()}:
                    self._idle_release(lease, run_id)
                return True
            client, done = self._take(lease)
        self._revoke(run_id, client, reason, done)
        return True

    def release_all(self, reason):
        with self._lock:
            self._task_runs.clear()
            held = [(self._owner.get(lease, lease), *self._take(lease)) for lease in list(self._held)]
        for run_id, client, done in held:
            self._revoke(run_id, client, reason, done)

    def held(self):
        """lease (conversation id, or run id) -> native session id."""
        with self._lock:
            return {lease: client.session_id for lease, client in self._held.items()}

    def _idle_release(self, lease, run_id):
        """Called under _lock."""
        def fire():
            with self._lock:
                if self._idle.get(lease) is not timer:
                    return
                client, done = self._take(lease)
            self._revoke(run_id, client, "conversation_idle", done)
        timer = self._idle[lease] = self._timer(IDLE_RELEASE, fire)
        timer.daemon = True
        timer.start()

    def _take(self, lease):
        """Called under _lock: removes a held lease; returns (client, its in-flight Event)."""
        self._owner.pop(lease, None)
        timer = self._idle.pop(lease, None)
        if timer is not None:
            timer.cancel()
        return self._held.pop(lease), self._in_flight()

    def _in_flight(self):
        """Called under _lock, in the same hold that took the lease, so no acquire can miss it."""
        done = threading.Event()
        self._releasing.add(done)
        return done

    def _revoke(self, run_id, client, reason, done):
        def revoke():
            try:
                _revoke(client.config, client.session_id, reason, 3)
            finally:
                with self._lock:
                    self._releasing.discard(done)
                done.set()
        # Its own socket and bounded timeout; never waits behind a pending observe.
        threading.Thread(target=revoke, daemon=True).start()
        self._report("desktop.lease_released", {"run_id": run_id, "session_id": client.session_id, "reason": reason},
                     run_id)
