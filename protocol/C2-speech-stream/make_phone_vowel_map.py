"""Write phone-vowel-map.json: GPT-SoVITS phone -> mouth pose (a/i/u/e/o) and weight.

Rules approved by the user on 2026-10-18 (review material: animation's notes/worklines/animation/phone-vowel-review.md):
compound finals map to their main vowel only; i0 -> i and ir -> e at weight 0.5; the ü finals v, vn -> u;
every other row as proposed. Phones not in the map (initials, pauses, Japanese N/cl/I/U/consonants) emit no cue.
"""
import json
import os

# Chinese finals without tone (GPT-SoVITS symbols2.v_without_tone, 39 entries); tones 1-5 share the vowel.
ZH_FINALS = {
    "a": "a", "ai": "a", "an": "a", "ang": "a", "ao": "a",
    "e": "e", "E": "e", "En": "e", "ei": "e", "en": "e", "eng": "e", "er": "e",
    "i": "i", "i0": "i", "ir": "e",
    "ia": "a", "ian": "e", "iang": "a", "iao": "a", "ie": "e", "in": "i", "ing": "i", "iong": "u", "iu": "o",
    "o": "o", "ong": "u", "ou": "o",
    "u": "u", "ua": "a", "uai": "a", "uan": "a", "uang": "a", "ui": "e", "un": "e", "uo": "o",
    "v": "u", "van": "e", "ve": "e", "vn": "u",
}
HALF_WEIGHT = {"i0", "ir"}
JA_VOWELS = ("a", "i", "u", "e", "o")


def build():
    phones = {}
    for final, vowel in ZH_FINALS.items():
        for tone in "12345":
            phones[final + tone] = {"vowel": vowel, "weight": 0.5 if final in HALF_WEIGHT else 1.0}
    for vowel in JA_VOWELS:
        phones[vowel] = {"vowel": vowel, "weight": 1.0}
    return {"schema": "endfield-phone-vowel-map-v1", "approved": "user 2026-10-18",
            "gpt_sovits_commit": "1b47ca07", "phones": phones}


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phone-vowel-map.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(build(), f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(out)
