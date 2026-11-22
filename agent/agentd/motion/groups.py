"""Which existing pool each clip of a character's motion graph that the pack does not draw could join, by the rules of
groups.json. A proposal changes nothing she plays until the user accepts it as a pool override.

    propose(chooser, graph) -> {character, pools, excluded, unclassified, counts}

Each graph clip lands in one place, checked in this order: a pack pool (or a chain one draws), `excluded` as `wired`
(the pack plays it some other way), an exclusion rule, `excluded` as `in_chain` (only another clip's chain reaches
it), a name-token rule, a structure rule, else `unclassified`. A rule's pool is the first of its keys the chooser knows
whose posture is the clip's start posture, else the first it knows; the chooser's pool check sorts the clip into that
pool's `proposal` or `rejected`."""
import json
from pathlib import Path

from motion.chooser import POSTURES

RULES = json.loads(Path(__file__).with_name("groups.json").read_text(encoding="utf-8"))


def _pack_rows(p, key):
    """(clip, weight) the pack's pool `key` draws without overrides."""
    if key.startswith("click.") and key != "click.repeat":  # play_click_reaction reads only the events pool
        return list(p.events[key].pool)
    if p.contexts.get(key):
        return [(c, p.weight(c, key)) for c in p.contexts[key]]
    return list(p.events[key].pool if key in p.events else p.tiers[int(key[len("idle.t"):]) - 1].pool)


def _played(p, clip):
    """clip, its chain and each held loop's exit chain."""
    clips = set()
    for x in p.chain(clip):
        clips.add(x)
        if x in p.entries and p.entries[x].exit:
            clips.update(p.chain(p.entries[x].exit))
    return clips


def _matches(clip, tokens):
    name = clip.lower()
    return any(t in name for t in tokens)


def _start(p, clip):
    s = p.stances[clip][0] if clip in p.stances else "stand"
    return s if s in POSTURES else "stand"


def _target(postures, targets, posture):
    """The pool key for targets (keys; `idle.*` is every idle tier in order); None when the chooser knows none."""
    known = []
    for t in targets:
        for k in ([k for k in postures if k.startswith("idle.t")] if t == "idle.*" else [t]):
            if k in postures and k not in known:
                known.append(k)
    return next((k for k in known if postures[k] == posture), known[0] if known else None)


def _structure(p, clip, postures):
    """`chain` (a chain with a loop after its start), `loop` (a loop that ends in the posture it starts in, which an
    idle tier has), `one_shot` (a standing one-shot shorter than one_shot_max_s whose chain comes to rest standing) or
    None."""
    if clip not in p.rules or clip not in p.lengths:
        return None
    chain, start = p.chain(clip), _start(p, clip)
    if len(chain) > 1 and any(p.loop(c) for c in chain[1:]):
        return "chain"
    if p.loop(clip):
        tiers = {v for k, v in postures.items() if k.startswith("idle.t")}
        return "loop" if p.posture(clip) == start and start in tiers else None
    if p.lengths[clip] < RULES["one_shot_max_s"] and p.standing(clip) and p.posture(p.rest_clip(clip)) == "stand":
        return "one_shot"
    return None


def propose(chooser, graph):
    p = chooser.pack
    keys = list(p.events) + ["idle.t%d" % (i + 1) for i in range(len(p.tiers or []))]
    postures = {k: chooser._pool_posture(k) for k in keys if chooser._pool_posture(k) is not None}
    pools, pooled = {}, set()
    for k, posture in postures.items():
        rows = _pack_rows(p, k)
        pools[k] = {"posture": posture, "pack": [{"clip": c, "weight": w} for c, w in rows], "proposal": [],
                    "rejected": []}
        for c, _ in rows:
            pooled |= _played(p, c)
    starts = set(graph["chains"])
    excluded, unclassified = [], []
    counts = {"clips": len(graph["clips"]), "pooled": 0, "proposed": 0, "rejected": 0, "excluded": 0,
              "unclassified": 0}
    for row in graph["clips"]:
        c = row["name"]
        if c in pooled:
            counts["pooled"] += 1
            continue
        if row["group"] != "unwired":
            reason = "wired"
        else:
            reason = next((r["reason"] for r in RULES["exclude"] if _matches(c, r["tokens"])), None)
            if reason is None and c not in starts:
                reason = "in_chain"
        if reason:
            excluded.append({"clip": c, "reason": reason})
            counts["excluded"] += 1
            continue
        key = why = None
        for r in RULES["rules"]:
            if _matches(c, r["tokens"]):
                key, why = _target(postures, r["pools"], _start(p, c)), "token:" + r["id"]
                if key:
                    break
        if key is None:
            kind = _structure(p, c, postures)
            if kind:
                key, why = _target(postures, RULES["structure"][kind], _start(p, c)), "structure:" + kind
        if key is None:
            unclassified.append(c)
            counts["unclassified"] += 1
            continue
        rejection = chooser._pool_rejection([c], postures[key])
        if rejection:
            pools[key]["rejected"].append({"clip": c, "reason": rejection})
            counts["rejected"] += 1
        else:
            pools[key]["proposal"].append({"clip": c, "weight": 1, "why": why})
            counts["proposed"] += 1
    return {"character": p.id, "pools": pools, "excluded": excluded, "unclassified": unclassified, "counts": counts}
