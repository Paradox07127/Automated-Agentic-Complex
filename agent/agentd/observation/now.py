"""The user's "now" (front app and window, what the window is of, the latest actions), set by rules from each batch of
stored timeline records, with the ids of the records behind it. observation.timeline keeps the one state."""
import re

RECENT = 10  # actions kept
TEXT = 200  # characters of a typed value or a selection an action shows
ACTIONS = ("click", "context_menu", "shortcut", "submit", "text_input", "selection")
CLICKS = ("click", "context_menu")
WINDOW = ("app", "bundle_id", "window", "window_id", "url_host", "artifact", "since")
# start_id: the record the current window began with; actions: [{id, ts, kind, app, keys, field}], oldest first, field
# being a text input's target label (what joins a run of inputs into one field), None for the other kinds.
EMPTY = {**dict.fromkeys(WINDOW), "start_id": None, "actions": [], "updated_at": None}


def artifact(title, app, url_host):
    """What a window is of: its title without the app's name at its end, after the page's host."""
    if title and app:
        title = re.sub(rf"\s+[-—–|·]\s+{re.escape(app)}$", "", title)
    return " · ".join(p for p in (url_host, title) if p) or None


def target_label(t, kind):
    """`role "label"` of an action's target; a click on text is labelled by the text."""
    if t is None:
        return ""
    role = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", (t.get("role") or "").removeprefix("AX")).lower()
    label = t.get("title") or t.get("description") or (t.get("value") if kind in CLICKS else None) or t.get("identifier")
    return f'{role} "{label[:120]}"' if label else role


def _field(a):
    return a["app"], a["kind"], a["field"]


def advance(state, records, at):
    """state after records (stored rows with their ids) at clock time at: each sets the front window, a new one with
    its time as since; each action joins the latest RECENT, a run of inputs into one field as its last one."""
    state = {**state, "actions": list(state["actions"])}
    for r in sorted(records, key=lambda r: (r["ts"], r["id"])):
        if (r["app"], r["bundle_id"], r["window_id"]) != (state["app"], state["bundle_id"], state["window_id"]):
            state.update(since=r["ts"], start_id=r["id"])
        state.update(app=r["app"], bundle_id=r["bundle_id"], window=r["window_title"], window_id=r["window_id"],
                     url_host=r["url_host"], artifact=artifact(r["window_title"], r["app"], r["url_host"]))
        if r["kind"] not in ACTIONS:
            continue
        action = {"id": r["id"], "ts": r["ts"], "kind": r["kind"], "app": r["app"], "keys": r["keys"],
                  "field": target_label(r["target"], r["kind"]) if r["kind"] == "text_input" else None}
        actions = state["actions"]
        if r["kind"] == "text_input" and actions and _field(actions[-1]) == _field(action):
            actions[-1] = action
        else:
            actions.append(action)
        del actions[:-RECENT]
    state["updated_at"] = at
    return state


def shown(state, live):
    """state as its records allow now. live: {record id: record} of the records that still exist and are not hidden.
    An action whose record is gone drops out, the others take their target and text from their record; the window fields
    go with the record the window began with. basis lists the records behind what is left."""
    actions = [{"id": a["id"], "ts": a["ts"], "kind": a["kind"], "app": a["app"], "keys": a["keys"],
                "target": target_label(live[a["id"]]["target"], a["kind"]) or None, "text": _text(live[a["id"]])}
               for a in state["actions"] if a["id"] in live]
    out = {**state, "actions": actions}
    if state["start_id"] not in live:
        out.update(dict.fromkeys(WINDOW), start_id=None)
    out["basis"] = [i for i in (out["start_id"], *(a["id"] for a in actions)) if i is not None]
    return out


def _text(r):
    if r["kind"] == "text_input":
        value = (r["target"] or {}).get("value") or r["text"]
    elif r["kind"] == "selection":
        value = r["text"]
    else:
        return None
    return value[:TEXT] if value else None
