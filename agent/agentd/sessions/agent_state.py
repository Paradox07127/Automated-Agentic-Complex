"""One agent state for her body and the status tag, from session states, counts and times only, never titles."""
BUSY = frozenset({"running_tool", "thinking", "compacting", "subagent"})
DONE_FRESH = 60.0  # seconds a successful finish keeps the state done
FAILED_FRESH = 120.0  # seconds an error keeps the state failed


def agent_state(registry_snapshot, pending, recent_terminals, now):
    """registry_snapshot: {"sessions": [{effective_state, since}]}, her own run as one more row; pending: the since of
    each pending approval or question; recent_terminals: (state "done" | "error", ts) of ended sessions and runs.
    -> {state, since, count}: waiting_you > failed > working > done > idle, since the earliest of its causes."""
    sessions = registry_snapshot["sessions"]
    causes = (
        ("waiting_you", list(pending) + [s["since"] for s in sessions if s["effective_state"] == "awaiting_input"]),
        ("failed", [ts for state, ts in recent_terminals if state == "error" and now - ts < FAILED_FRESH]),
        ("working", [s["since"] for s in sessions if s["effective_state"] in BUSY]),
        ("done", [ts for state, ts in recent_terminals if state == "done" and now - ts < DONE_FRESH]),
    )
    for state, times in causes:
        if times:
            return {"state": state, "since": min(times), "count": len(times)}
    return {"state": "idle", "since": None, "count": 0}
