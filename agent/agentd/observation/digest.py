"""One timeline segment as compact text, by rules only (no model): what the 10-minute summary and the live state read."""
import datetime
import re

from observation.now import CLICKS, target_label
from observation.timeline import SEGMENT_S

CAP = 8000  # characters of a digest
LINE = 300  # characters a tree line keeps
VALUE = 500  # characters a typed value or a selection keeps
GAP_S = 120  # the most dwell one record gets; a longer gap is time away
MIN_DWELL = 30.0  # the least an app weighs when the budget is shared, so a short visit keeps a few lines
NODE = re.compile(r"([+~-]?)\t*\d+ (.*)")
SHOWING = re.compile(r" ?\(showing [^)]*\)")
STATES = re.compile(r" ?\([^)]*\)")
# A line that is only one of these roles (the helper's names and Codex's) says nothing.
BARE = frozenset(("container", "group", "unknown", "layout area", "layout item", "split group", "scroll area", "cell",
                  "row", "column", "image", "splitter", "toolbar", "list", "outline", "table", "content", "text",
                  "static text", "menu bar", "tab group", "generic", "section", "standard window", "web area",
                  "content list", "html content", "browser", "landmark", "region"))
# Roles whose name before a label adds nothing.
PLAIN = ("container ", "group ", "static text ", "text ")


def _tree_lines(tree):
    """A full tree's lines or a diff's + and ~ lines, without ids, depth, the showing ranges, bare roles, lines with
    no letter or digit and a line the one above ends with (a control's label repeated by its text child)."""
    if tree is None or tree["mode"] not in ("full", "diff"):  # no_change adds nothing
        return []
    out, kept = [], False
    for raw in tree["text"].split("\n"):
        node = NODE.match(raw)
        if node is None:  # Codex leaves a value's line breaks in: the rest of the line above
            if kept and raw.strip():
                out[-1] += " " + raw.strip()
            continue
        op, body = node.groups()
        body = SHOWING.sub("", body).strip()
        line = next((body[len(p):] for p in PLAIN if body.startswith(p)), body)
        kept = (op in ("+", "~") if tree["mode"] == "diff" else True) and STATES.sub("", body).strip().lower() not in BARE \
            and any(c.isalnum() for c in line) and not (out and out[-1].endswith(line))
        if kept:
            out.append(line)
    return [line[:LINE] for line in out]


def _field(r):
    """What makes two text inputs one: the window and the field."""
    t = r["target"] or {}
    return r["app"], r["window_id"], t.get("role"), t.get("title"), t.get("description"), t.get("identifier")


def _events(records):
    """[(ts, app, headline, lines)] in time order: a run of clicks in one window is one event, a run of inputs into
    one field is its last value, a run of selections the last one."""
    events, seen = [], {}  # seen: app -> tree lines already given
    previous = None
    for r in records:
        kind, app = r["kind"], r["app"] or "?"
        if kind == "selection" and not r["text"]:
            continue
        lines, known, fresh = _tree_lines(r["tree"]), seen.setdefault(app, set()), []
        for line in lines:
            if line not in known:
                known.add(line)
                fresh.append(line)
        last = events[-1] if events else None
        if kind in CLICKS and previous is not None and previous["kind"] in CLICKS \
                and (previous["app"], previous["window_id"]) == (r["app"], r["window_id"]):
            last[2] += f" → {target_label(r['target'], kind)} (+{len(lines)})"
            last[3] += fresh
        elif kind == "text_input" and previous is not None and previous["kind"] == "text_input" \
                and _field(previous) == _field(r):
            events[-1] = [last[0], app, _typed(r), last[3] + fresh]
        elif kind == "selection" and previous is not None and previous["kind"] == "selection" \
                and previous["app"] == r["app"]:
            events[-1] = [last[0], app, f'selected "{(r["text"] or "")[:VALUE]}"', last[3] + fresh]
        else:
            events.append([r["ts"], app, _headline(r, len(lines)), fresh])
        previous = r
    return events


def _typed(r):
    value = (r["target"] or {}).get("value") or r["text"] or ""  # the field's value is final; text may be a fragment
    where = target_label(r["target"], "text_input")
    return f'typed{" in " + where if where else ""}: "{value[:VALUE]}"'


def _headline(r, changed):
    """changed: the tree lines the record's tree gave."""
    kind, where = r["kind"], target_label(r["target"], r["kind"])
    if kind == "window":
        host = f" ({r['url_host']})" if r["url_host"] else ""
        return f'window "{r["window_title"] or ""}"{host}'
    if kind in CLICKS:
        return f"{'clicked' if kind == 'click' else 'context menu on'} {where} (+{changed})"
    if kind == "text_input":
        return _typed(r)
    if kind == "selection":
        return f'selected "{(r["text"] or "")[:VALUE]}"'
    return f"{kind} {r['keys'] or ''}{' in ' + where if where else ''}"  # shortcut, submit


def _dwell(records):
    """Seconds per app: each record holds until the next, at most GAP_S; the last until its segment ends."""
    dwell = {}
    for r, after in zip(records, records[1:] + [None]):
        until = after["ts"] if after else (r["ts"] // SEGMENT_S + 1) * SEGMENT_S
        app = r["app"] or "?"
        dwell[app] = dwell.get(app, 0.0) + min(max(until - r["ts"], 0.0), GAP_S)
    return dwell


def _when(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S")


def _section(app, minutes, events, budget):
    """An app's lines in at most budget characters, newlines counted: the headlines first, then each one's tree
    lines in time order while they fit; headlines past the budget are counted, not shown."""
    head = f"## {app} ({minutes} min)"[:budget]
    heads = [f"{_when(ts)} {headline}" for ts, _, headline, _ in events]
    used, shown = len(head), 0
    for i, line in enumerate(heads):
        rest = len(heads) - i - 1
        if used + 1 + len(line) + (len(f"\n… {rest} more actions") if rest else 0) > budget:
            break
        used += 1 + len(line)
        shown += 1
    more = f"… {len(heads) - shown} more actions" if shown < len(heads) else ""
    if more and used + 1 + len(more) <= budget:
        used += 1 + len(more)
    else:
        more = ""
    out = [head]
    for (_, _, _, lines), line in zip(events, heads[:shown]):
        out.append(line)
        tree = "  " + " | ".join(lines) if lines else ""
        if tree and used + 1 + len(tree) > budget:
            tree = tree[:budget - used - 2] + "…" if budget - used > 40 else ""
        if tree:
            out.append(tree)
            used += 1 + len(tree)
    return "\n".join(out + ([more] if more else []))


def _shares(needs, weights, total):
    """Characters per app: total split by weight, an app that needs less than its share giving the rest to the others."""
    shares, open_ = {}, set(needs)
    while open_:
        left = total - sum(shares.values())
        weight = sum(weights[a] for a in open_)
        small = {a for a in open_ if needs[a] <= left * weights[a] / weight}
        if not small:
            shares.update({a: int(left * weights[a] / weight) for a in open_})
            break
        shares.update({a: needs[a] for a in small})
        open_ -= small
    return shares


def digest(records, cap=CAP):
    """Timeline records (Timeline.records' shape) as at most cap characters: one section per app, in the order of
    their first record, each line an action with the tree lines it added. Over cap the apps share it by dwell."""
    records = sorted(records, key=lambda r: r["ts"])
    if not records:
        return ""
    start = records[0]["ts"] // SEGMENT_S * SEGMENT_S
    top = (f"{datetime.datetime.fromtimestamp(start):%Y-%m-%d %H:%M}–"
           f"{datetime.datetime.fromtimestamp(records[-1]['ts']):%H:%M}")
    dwell, by_app = _dwell(records), {}
    for event in _events(records):
        by_app.setdefault(event[1], []).append(event)
    minutes = {app: round(dwell.get(app, 0.0) / 60) for app in by_app}
    full = {app: _section(app, minutes[app], events, 1 << 30) for app, events in by_app.items()}
    text = "\n".join([top, *full.values()])
    if len(text) <= cap:
        return text
    room = cap - len(top) - len(by_app)  # one newline before each section
    shares = _shares({app: len(s) for app, s in full.items()}, {app: max(dwell.get(app, 0.0), MIN_DWELL) for app in by_app},
                     room)
    return "\n".join([top, *(_section(app, minutes[app], events, shares[app]) for app, events in by_app.items())])
