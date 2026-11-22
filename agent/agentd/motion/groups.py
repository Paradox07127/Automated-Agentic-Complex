"""Which pools each clip of a character's motion graph could join, by the rules of groups.json. A proposal changes
nothing she plays until the user accepts it as a pool override.

    propose(chooser, graph) -> {character, pools, excluded, unclassified, counts}

`pools` has every event key agentd knows and each idle tier. A clip the pack draws (a pack pool, or a chain one draws)
gets only meaning-rule proposals, for pools it is not in, when it starts a chain and no exclusion rule matches it. Any
other clip is `excluded` as `wired` (the pack plays it some other way), by an exclusion rule, or as `in_chain` (only
another clip's chain reaches it); else it is proposed by the first name-token rule with a pool and by every meaning
rule, or when none applies by a structure rule; else it is `unclassified`. A token or structure rule's pool is the
first of its keys the chooser knows whose posture is the clip's start posture, else the first it knows. A meaning key
`k` is `k` for a standing clip and `k@<posture>` for another (a key with `@` only for its own posture), dropped when
the chooser does not know it. The chooser's pool check sorts the clip into each pool's `proposal` or `rejected`."""
import json
from pathlib import Path

from motion.chooser import EVENT_RULES, POSTURES

RULES = json.loads(Path(__file__).with_name("groups.json").read_text(encoding="utf-8"))


def _pack_rows(p, key):
    """(clip, weight) the pack's pool `key` draws without overrides; [] for an event key the pack lacks."""
    event = p.pack_events.get(key)
    if key.startswith("click.") and key != "click.repeat":  # play_click_reaction reads only the events pool
        return list(event.pool) if event else []
    if p.contexts.get(key):
        return [(c, p.weight(c, key)) for c in p.contexts[key]]
    if key.startswith("idle.t"):
        return list(p.tiers[int(key[len("idle.t"):]) - 1].pool)
    return list(event.pool) if event else []


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


def _words(clip):
    """The clip name's `_`-separated words, lower case, without trailing digits."""
    return {w.rstrip("0123456789") for w in clip.lower().split("_")}


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


def _meant(postures, words, posture):
    """(key, why) for each meaning rule a word of the clip matches, each key in the clip's posture."""
    out = []
    for r in RULES["meanings"]:
        if words & set(r["words"]):
            for k in r["pools"]:
                k = k if "@" in k or posture == "stand" else k + "@" + posture
                if postures.get(k) == posture:
                    out.append((k, "meaning:" + r["id"]))
    return out


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
    keys = list(EVENT_RULES) + ["idle.t%d" % (i + 1) for i in range(len(p.tiers or []))]
    postures = {k: chooser._pool_posture(k) for k in keys if chooser._pool_posture(k) is not None}
    pools, pooled, own = {}, set(), {}
    for k, posture in postures.items():
        rows = _pack_rows(p, k)
        pools[k] = {"posture": posture, "pack": [{"clip": c, "weight": w} for c, w in rows], "proposal": [],
                    "rejected": []}
        for c, _ in rows:
            pooled |= _played(p, c)
            own.setdefault(c, set()).add(k)
    starts = set(graph["chains"])
    excluded, unclassified = [], []
    counts = {"clips": len(graph["clips"]), "pooled": 0, "proposed": 0, "rejected": 0, "excluded": 0,
              "unclassified": 0, "proposals": 0}
    for row in graph["clips"]:
        c = row["name"]
        start = _start(p, c)
        rule = next((r["reason"] for r in RULES["exclude"] if _matches(c, r["tokens"])), None)
        if c in pooled:
            targets = [] if rule or c not in starts else [
                (k, why) for k, why in _meant(postures, _words(c), start) if k not in own.get(c, ())]
        else:
            reason = "wired" if row["group"] != "unwired" else rule or (None if c in starts else "in_chain")
            if reason:
                excluded.append({"clip": c, "reason": reason})
                counts["excluded"] += 1
                continue
            targets = []
            for r in RULES["rules"]:
                if _matches(c, r["tokens"]):
                    key = _target(postures, r["pools"], start)
                    if key:
                        targets.append((key, "token:" + r["id"]))
                        break
            targets += _meant(postures, _words(c), start)
            if not targets:
                kind = _structure(p, c, postures)
                key = kind and _target(postures, RULES["structure"][kind], start)
                if key:
                    targets.append((key, "structure:" + kind))
            if not targets:
                unclassified.append(c)
                counts["unclassified"] += 1
                continue
        placed, proposed = set(), 0
        for key, why in targets:
            if key in placed:
                continue
            placed.add(key)
            rejection = chooser._pool_rejection([c], postures[key])
            if rejection:
                pools[key]["rejected"].append({"clip": c, "reason": rejection})
            else:
                pools[key]["proposal"].append({"clip": c, "weight": 1, "why": why})
                proposed += 1
        counts["proposals"] += proposed
        counts["pooled" if c in pooled else "proposed" if proposed else "rejected"] += 1
    return {"character": p.id, "pools": pools, "excluded": excluded, "unclassified": unclassified, "counts": counts}
