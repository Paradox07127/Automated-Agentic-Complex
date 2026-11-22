"""GET /trace/*, POST /trace/events and GET /diag/stream."""
import json
import time
from urllib.parse import parse_qs, urlparse

from traces.trace_store import BATCH_MAX, PAGE_MAX


class DiagMixin:
    def _trace_read(self, path, match, query):
        store = self.server.trace
        if store is None:
            return self._json(503, {"error": "no_trace"})
        with_text = query.get("with_text", ["0"])[0] == "1"
        if match:
            found = store.turn(match.group(1), with_text)
            if not found["events"]:
                return self._json(404, {"error": "unknown_trace"})
            return self._json(200, found)
        if path == "/trace/export":
            return self._json(200, {"events": store.export(with_text)})
        one = lambda key: query[key][0] if key in query else None  # noqa: E731
        try:
            raw = parse_qs(urlparse(self.path).query, keep_blank_values=True)
            if path == "/trace/turns":
                ids = {key: raw[key][0] for key in ("turn_id", "trace_id") if key in raw}
                turns = store.turns(one("since"), int(query.get("limit", ["50"])[0]), one("source"),
                                    one("result"), **ids)
                conversations = self.server.history.conversations if self.server.history else None
                owners = conversations.owners_of_turns(t["turn_id"] for t in turns) if conversations else {}
                for turn in turns:
                    turn["conversation_id"] = owners.get(turn["turn_id"])
                body = {"turns": turns}
            elif path == "/trace/events":
                kinds = raw["kinds"][0].split(",") if "kinds" in raw else None
                events, cursor = store.events(one("since"), one("until"), kinds,
                                              int(query.get("limit", [str(PAGE_MAX)])[0]), raw.get("cursor", [None])[0])
                body = {"events": events, "cursor": cursor}
            else:
                limit = int(query.get("limit", ["100"])[0])
                if not 1 <= limit <= PAGE_MAX:
                    raise ValueError(limit)
                # parse_qs drops blank values, so an empty id is looked for in the raw query.
                ids = {key: raw[key][0] for key in ("trace_id", "request_id") if key in raw}
                if "" in ids.values():
                    raise ValueError(ids)
                body = {"events": store.decisions(one("kind"), one("since"), limit, **ids)}
        except (ValueError, TypeError):  # TypeError: a since without a time zone
            return self._json(400, {"error": "invalid_query"})
        self._json(200, body)

    def _trace_events(self, body):
        store = self.server.trace
        if store is None:
            return self._json(503, {"error": "no_trace"})
        events = body.get("events") if isinstance(body, dict) else None
        if not isinstance(events, list):
            return self._json(400, {"error": "invalid_payload"})
        if len(events) > BATCH_MAX:
            return self._json(413, {"error": "too_many"})
        result = store.ingest(events)
        turn, rejected = self.server._turn_trace, {r["index"] for r in result["rejected"]}
        if turn is not None:  # the host's receipts for the current turn move its phase in /diag/state
            turn["marks"] += [(e["kind"], time.monotonic()) for i, e in enumerate(events)
                              if i not in rejected and e["trace_id"] == turn["trace_id"]]
        self._json(200, result)

    def _diag_stream(self):
        """GET /diag/stream: a full `state` first, then `state` on change, `trace` and `decision` items.
        Last-Event-ID resumes after that item; one pushed out of the buffer or from another process gets
        `reset` and a full `state`."""
        server, diag = self.server, self.server.diag
        raw, seq, reset = self.headers.get("Last-Event-ID"), diag.seq, None
        if raw is not None:
            boot, _, after = raw.rpartition("-")
            oldest = diag.items[0]["seq"] if diag.items else diag.seq + 1
            if boot != server.diag_boot or not after.isdigit():
                reset = "other_process"
            elif not oldest - 1 <= int(after) <= diag.seq:
                reset = "cursor_expired"
            else:
                seq = int(after)
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with server._diag_lock:
            server._diag_clients += 1
        try:
            if reset:
                self.wfile.write(f"event: reset\ndata: {json.dumps({'reason': reset})}\n\n".encode())
            if raw is None or reset:
                seq = diag.seq
                self.wfile.write((f"id: {server.diag_boot}-{seq}\nevent: state\ndata: "
                                  + json.dumps(server.diag_state(), ensure_ascii=False) + "\n\n").encode())
            while True:
                for item in diag.since(seq):
                    self.wfile.write((f"id: {server.diag_boot}-{item['seq']}\nevent: {item['event']}\ndata: "
                                      + json.dumps(item["data"], ensure_ascii=False) + "\n\n").encode())
                    seq = item["seq"]
                self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
                diag.wait(seq, 10)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with server._diag_lock:
                server._diag_clients -= 1

    def _stream_cursor(self, buffer, raw):
        """(seq to resume after, buffer.stream_state(), None or ("reset" | "gap", data)) for a
        `<stream_epoch>-<seq>` cursor; a bare seq is this epoch's. ValueError when malformed."""
        state = buffer.stream_state()
        if raw is None:
            return state["latest_seq"], state, None
        epoch, _, after = raw.rpartition("-")
        after = int(after)
        # A seq past the newest one was handed out by another process (a bare id from before a restart).
        if epoch and epoch != state["stream_epoch"] or after > state["latest_seq"]:
            return state["latest_seq"], state, ("reset", {"reason": "other_process", **state})
        if after < state["oldest_seq"] - 1:
            return after, state, ("gap", {"reason": "cursor_expired", "from": after + 1,
                                          "to": state["oldest_seq"] - 1, **state})
        return after, state, None
