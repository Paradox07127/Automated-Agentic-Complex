"""Shutdown, chat clear, POST /reset and server close."""
from contextlib import closing, ExitStack
from pathlib import Path
import threading
import time

from infra import paths
from infra.data_lifecycle import DataLifecycle
from infra.store import checkpoint, compact, count_rows, path_of
from api.views import _iso


class LifecycleMixin:
    def shutdown_cleanly(self, timeout=5.0):
        """Once: stop taking tasks, retire pending approvals, stop own sessions within timeout, stop serving."""
        with self._closing_lock:
            if self.closing:
                return
            self.closing = True
        deadline = time.monotonic() + timeout
        self._cancel_closing_turns()
        self.broker.cancel_all(reason="shutdown")
        if self.character_agent is not None:
            self.character_agent.close()
        if self.sessions is not None:
            self.sessions.close(timeout)
        self._wait_for_closing_turns(deadline)
        self.shutdown()
        if self.state is not None:
            self.state.flush()

    def _cancel_closing_turns(self):
        # An admitted line registers under this lock before starting its worker.
        with self._switch_lock:
            look_pending = self._look is not None and self.capture is not None \
                and self.capture.result(self._look) == "pending"
            if self._live_lines or self._voiced is not None or look_pending:
                self.cancel_turn("client_cancel")
                for cancel in tuple(self._live_lines):
                    cancel.set()

    def _wait_for_closing_turns(self, deadline):
        while self._live_lines and time.monotonic() < deadline:
            time.sleep(0.01)

    def _forget_agent_data(self):
        controller = self.character_agent
        if controller is not None:
            controller.forget()
        if self.state_dir is None:
            return
        from tool_gateway.ledger import ledger_path
        from character_agent.services.store import RunStore
        from character_agent.services.workspace import WorkspaceService
        ledger = ledger_path(self.state_dir)
        if controller is None and ledger.is_file():
            with closing(RunStore(ledger)) as store:
                store.forget()
        directory = self.state_dir / "character-agent" / "files"
        if (controller is None or controller.workspace is None) and (directory / "character-workspace.sqlite").is_file():
            with closing(WorkspaceService(directory)) as workspace:
                workspace.forget()

    def clear_history(self):
        """DELETE /history and /memory?scope=history|all, in /reset's order: the live turn ends, then nothing a line
        from before stores lands, then the rows, the mouth's window and the trace go. The rows deleted."""
        self.cancel_turn("client_cancel")
        self._forget_agent_data()
        with self._write_lock:
            self.history_generation += 1
            self._line_entries.clear()
            self._cut_lines.clear()
            self._window_ops.clear()
        deleted = self.history.clear()
        if self.mouth is not None:
            self.mouth.history.clear()
        if self.trace is not None:
            self.trace.clear()
            checkpoint(self.trace)
        checkpoint(self.history)
        return deleted

    def reset(self, timeout=5.0):
        """POST /reset:stop the writers, clear the user's data in every store, then count each cleared table
        on a fresh connection. (status, body); 409 while another reset runs."""
        if not self._reset_lock.acquire(blocking=False):
            return 409, {"error": "resetting"}
        try:
            with self._slot_lock:  # a claim already admitted registers its line before reset clears the index
                self.resetting = True
            with self._feedback_lock:
                self._proactive_lines.clear()
                self._feedback_seen.clear()
                if self.proactive is not None:
                    self.proactive.reset_feedback()
            with self._switch_lock:  # an open switch is aborted
                self.switch = None
            deadline = time.monotonic() + timeout
            self.cancel_turn("client_cancel")
            while self._live_lines and time.monotonic() < deadline:  # a cancelled line still records its row
                time.sleep(0.01)
            if self.sessions is not None:
                self.sessions.stop_all(max(0.0, deadline - time.monotonic()))
            self.broker.cancel_all(reason="reset")
            self.broker.forget()
            with self._write_lock:  # a line still running past the deadline stores nothing from here
                self.reset_generation += 1
                self._cut_lines.clear()
                self._window_ops.clear()
            connections = [owner.db for owner in (self.history, self.memory, self.trace, self.state, self.rituals,
                                                 self.proactive_log)
                           if owner is not None]
            connections += [self.sessions.store] if self.sessions is not None and self.sessions.store is not None else []
            connections.append(self.receipts_db)
            if self.capture is not None and self.capture.budget.db is not None:
                connections.append(self.capture.budget.db)
            try:
                lifecycle = DataLifecycle(connections)
            except ValueError:
                return 500, {"error": "reset_schema_unclassified"}
            before = lifecycle.counts()
            deleted, files = {}, {}  # table -> rows deleted, table -> its SQLite file
            if self.history is not None:
                deleted["history_turns"], files["history_turns"] = self.history.clear(), path_of(self.history.db)
            if self.sessions is not None and self.sessions.store is not None:
                deleted["own_sessions"], files["own_sessions"] = self.sessions.clear(), path_of(self.sessions.store)
            if self.trace is not None:
                deleted["trace_events"], files["trace_events"] = self.trace.clear(), path_of(self.trace.db)
            if self.memory is not None:
                deleted["facts"], files["facts"] = self.memory.clear("all"), path_of(self.memory.db)
            if self.state is not None:
                files["character_state"] = path_of(self.state.db)
                deleted["character_state"] = self.clear_state(everyone=True)
            if self.rituals is not None:
                self.rituals.clear()
            if self.episodes is not None:  # its generation drops an episode still being written
                self.episodes.clear()
            self._ritual_kinds = []
            lifecycle.clear()
            if self.character_agent is not None:
                deleted.update(self.character_agent.data_counts())
            self._forget_agent_data()
            deleted.update(before)
            with ExitStack() as dormant:
                attention, timeline = self.attention, self.timeline
                if self.state_dir is not None:
                    from observation.attention import AttentionStore
                    from observation.blacklist import Blacklist
                    from observation.timeline import Timeline
                    if attention is None and paths.attention_db(self.state_dir).is_file():
                        attention = dormant.enter_context(closing(AttentionStore(paths.attention_db(self.state_dir),
                            Blacklist(paths.blacklist(self.state_dir)))))
                    if timeline is None and paths.timeline_db(self.state_dir).is_file():
                        timeline = dormant.enter_context(closing(Timeline(paths.timeline_db(self.state_dir),
                            Blacklist(paths.blacklist(self.state_dir)))))
                if attention is not None:
                    cleared = attention.clear_tables()
                    self.forget_user_state()
                    deleted.update(cleared)
                    files.update(dict.fromkeys(cleared, path_of(attention.db)))
                if timeline is not None:
                    deleted["timeline"], files["timeline"] = timeline.clear(), path_of(timeline.db)
            for path in set(files.values()) | lifecycle.paths:
                compact(path)
            owners = (self.capture, self.capture and self.capture.judge, self.proactive and self.proactive.judge,
                      self.egress and self.egress.guard)
            logs = [Path(owner.log_path).name for owner in owners if owner is not None and owner.truncate_log()]
            if self.state_dir is not None:
                for name in ("capture.jsonl", "capture-judge.jsonl", "proactive-judge.jsonl"):
                    path = self.state_dir / name
                    if name not in logs and path.is_file():
                        path.write_text("", encoding="utf-8")
                        logs.append(name)
            if self.capture is not None:
                self.capture.clear()
            if self.mouth is not None:
                self.mouth.history.clear()
            self._line_entries.clear()
            self._heard.clear()
            self._turn_facts = self._assembled = self._refused = self.correction = None
            with self._receipts_lock:
                self._receipts.clear()
            with self._announce_lock:
                self._announce_slots.clear()
                self._ended.clear()
            with self._decision_lock:
                self._decision_traces.clear()
            if self.thoughts is not None:  # before the feed resets, so a thought it publishes is cleared too
                self.thoughts.reset()
            for buffer in (self.feed, self.diag, self.speech):
                if buffer is not None:
                    buffer.reset()
            self.feed.publish("reset", {"at": _iso(time.time())})
            rows = {table: count_rows(path, table) for table, path in files.items()}
            rows.update(lifecycle.counts())
            if self.character_agent is not None:
                rows.update(self.character_agent.data_counts())
            if any(rows.values()):
                return 500, {"error": "reset_incomplete", "rows": rows}
            return 200, {"deleted": deleted, "rows": rows, "logs": logs}
        finally:
            self.resetting = False
            self._reset_lock.release()

    def server_close(self):
        with self._closing_lock:
            self.closing = True
        self._stopped.set()
        ticker = getattr(self, '_ticker', None)
        if ticker is threading.current_thread():
            # A ticker-originated shutdown cannot join itself or release the
            # objects still in its stack. Let another thread wait for its exit.
            threading.Thread(target=self.server_close, name='agentd-close', daemon=True).start()
            return
        deadline = time.monotonic() + 2.0
        try:
            if ticker is not None:
                ticker.join(timeout=2.0)
                if ticker.is_alive():
                    raise RuntimeError('ticker_not_stopped')
            self._cancel_closing_turns()
            self._wait_for_closing_turns(deadline)
            if self.character_agent is not None:
                self.character_agent.close()
        finally:
            super().server_close()
