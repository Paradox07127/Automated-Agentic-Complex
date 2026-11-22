"""The motion lane of the T1 trace: user_now's judged inputs and Spatial's motion decisions and feedback, each event
pointing at what caused it."""


class MotionLane:
    def __init__(self, emit=lambda kind, trace_id, **fields: None):
        """emit(kind, trace_id, **fields) -> event_id or None: AgentdServer._trace."""
        self.emit = emit
        # (trace_id, event_id) of the newest input event: signal.changed, stage.changed, a renderer's own motion.state
        self.newest = None
        self._refused = None  # (type, event, reason) of the refusal last written while nothing else was

    def write(self, kind, trace_id, causation_id, attrs, input=False):
        """One event; input True makes it the newest input. Returns its event_id, None when nothing was stored."""
        # a held body refuses the base loop's retry every HOLD_RETRY: a run of the same refusal is written once
        refused = (attrs["behavior_type"], attrs["trigger_event"], attrs["reason"]) if kind == "behavior.refused" else None
        if refused is not None and refused == self._refused:
            return None
        self._refused = refused
        event_id = self.emit(kind, trace_id, causation_id=causation_id, attrs=attrs)
        if input and event_id is not None:
            self.newest = (trace_id, event_id)
        return event_id
