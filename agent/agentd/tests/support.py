"""Shared test support: puts agentd on sys.path and sends JSON requests to a test case's live server."""
import http.client
import json
from pathlib import Path
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

UI = "ui-token"


def serve_in_thread(server):
    """Starts server.serve_forever on a daemon thread and returns the thread; the short poll lets shutdown() return at once."""
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return thread


def deny_blacklist(path):
    """path, holding the default blacklist.json in deny mode unless a file is there, for fixtures that observe
    ordinary windows."""
    from observation.blacklist import DEFAULTS
    if not path.exists():
        path.write_text(json.dumps({**DEFAULTS, "mode": "deny"}), encoding="utf-8")
    return path


def add_episode(episodes, start, end, title, description="", projects=(), requires=(), apps=(), hosts=(), titles=(),
                run_id=None):
    """An episode row as the memory pipeline commits one (version 3); its id. projects: {"subject", ...} each, a thread
    of the row with requires."""
    from personal.episodes import _body
    threads = [{**p, "requires": sorted(requires), "scope_ids": [], "topic": p["subject"], "session": p["subject"],
                "status": "unknown", "progress": p.get("outcome") or p.get("goal") or "", "blocked": False}
               for p in projects]
    dump = lambda value: json.dumps(list(value), ensure_ascii=False)  # noqa: E731
    row = {"start": start, "end": end, "title": title, "description": description, "threads": dump(threads),
           "open_questions": dump(q for p in projects for q in p.get("unresolved", [])), "apps": dump(apps),
           "hosts": dump(hosts), "created_at": episodes.clock(), "titles": dump(titles),
           "typed": int("typed_text" in requires), "presence": "unknown", "user_actions": "[]", "agent_actions": "[]",
           "version": 3, "run_id": run_id, "edited": 0}
    with episodes.lock:
        ident = episodes.db.execute(f"INSERT INTO episodes ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                                    tuple(row.values())).lastrowid
        episodes.db.execute("INSERT INTO episodes_fts (rowid, body) VALUES (?, ?)",
                            (ident, _body(title, description, threads, [])))
        episodes.db.commit()
    return ident


def request(self, method, path, body=None, token=UI, timeout=5):
    """A TestCase method: needs self.server, an AgentdServer serving on 127.0.0.1."""
    conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=timeout)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    raw = None if body is None else json.dumps(body).encode()
    conn.request(method, path, body=raw, headers=headers)
    response = conn.getresponse()
    data = json.loads(response.read() or b"null")
    conn.close()
    return response.status, data
