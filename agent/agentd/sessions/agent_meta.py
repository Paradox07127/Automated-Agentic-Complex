"""Hook metadata: a session's title is the one its hook sent; no agent's session or transcript file is read."""


def _text(value):
    return value if isinstance(value, str) and value else None


class AgentMeta:
    def session(self, source, session_id, transcript_path=None, hook_title=None):
        """{"title"}: the hook's session_title, None without one."""
        return {"title": _text(hook_title)}
