"""Constants more than one of the api/ and daemon/ modules read."""

VIEW_FRESH = 300.0  # seconds a vision description stays in the mouth's context
RECEIPTS_KEPT = 256  # session-command answers kept for repeats of their Idempotency-Key
SPEECH_TRACES = 64  # speeches whose relay events can still find their trace
LINE_ENTRIES = 32  # spoken lines whose mouth.history turn an interrupted receipt can still cut to what was heard
FEEDBACK = ("useful", "dont_disturb", "dismissed", "less")  # ignored is set by agentd, never posted
RAW_KINDS = ("app", "window", "focus", "value", "selection")
RAW_TEXT = {"app": 128, "bundle_id": 256, "window": 256, "doc": 512, "role": 64, "subrole": 64, "label": 120,
            "value": 2_000_000}
RAW_PAST, RAW_AHEAD = 600.0, 5.0
MAX_SAY = 2000
NO_HISTORY = {"error": "no_history", "detail": "聊天记录没有开启"}  # 503: the store is off, not broken
CLEARABLE = ("view", "window_text", "page", "selection")  # DELETE /context/items/<type>
SEEN = (*CLEARABLE, "activity")  # the context kinds DELETE /attention and /observation take away
