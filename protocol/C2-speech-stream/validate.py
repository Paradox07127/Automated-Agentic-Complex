"""Check one C2 speech-timeline NDJSON stream. Exit 0 when valid."""
import json
import sys

COMMON = ("event", "session_epoch", "turn_id", "speech_id", "seq")
REQUIRED = {
    "speech.begin": ("schema", "clock", "format", "channels", "lang", "engine", "expires_at_ms"),
    "segment": ("segment_index", "norm_text", "phones", "start_sample", "semantic_tokens",
                "token_hop_samples", "speech_samples", "tail_silence_samples"),
    "audio": ("segment_index", "start_sample", "samples", "pcm_base64"),
    "cues": ("segment_index", "revision", "source", "items"),
    "complete": ("total_samples", "segments", "cues_complete"),
    "cancelled": ("reason", "last_sample_sent"),
}
SCHEMAS = ("endfield-speech-timeline-v1", "endfield-speech-timeline-v2")
# v2 begin fields (CONTRACT-v2-draft.md §2); engine.voice_fingerprint stays optional.
V2_STRINGS = ("utterance_id", "clause_id", "voice_profile_id", "trace_id")
V2_POLICIES = {"immediate", "clause_end"}
VOWELS = {"a", "i", "u", "e", "o"}
SOURCES = {"mfa", "qwen3-fa", "mrte-attn", "ulipsync", "rms"}
LANGS = {"zh", "ja", "en"}


def check(lines):
    events = [json.loads(l) for l in lines if l.strip()]
    if not events or events[0].get("event") != "speech.begin":
        return "first line must be speech.begin"
    begin = events[0]
    if begin.get("schema") not in SCHEMAS or begin.get("clock", {}).get("sample_rate") != 48000:
        return "schema or sample_rate"
    if begin.get("lang") not in LANGS:
        return "lang"
    if begin["schema"] == SCHEMAS[1]:
        err = check_v2_begin(begin)
        if err:
            return err
    ids = tuple(begin.get(k) for k in COMMON[1:4])
    segments, next_audio, revisions, ended = {}, 0, {}, False
    for n, e in enumerate(events):
        kind = e.get("event")
        if kind not in REQUIRED or any(k not in e for k in COMMON + REQUIRED[kind]):
            return f"line {n}: unknown event or missing field"
        if e["seq"] != n or tuple(e[k] for k in COMMON[1:4]) != ids:
            return f"line {n}: seq or ids"
        if ended:
            return f"line {n}: event after end"
        if kind == "speech.begin" and n:
            return f"line {n}: second begin"
        if kind == "segment":
            if e["token_hop_samples"] != 1920 or e["speech_samples"] != 1920 * e["semantic_tokens"]:
                return f"line {n}: speech_samples != 1920*tokens"
            segments[e["segment_index"]] = e
        if kind == "audio":
            if e["start_sample"] != next_audio or e["samples"] <= 0:
                return f"line {n}: audio not contiguous"
            next_audio += e["samples"]
        if kind == "cues":
            seg = segments.get(e["segment_index"])
            if seg is None or e["source"] not in SOURCES:
                return f"line {n}: cues before segment or bad source"
            if e["revision"] < 1 or e["revision"] <= revisions.get(e["segment_index"], 0):
                return f"line {n}: revision must increase"
            revisions[e["segment_index"]] = e["revision"]
            lo, hi = seg["start_sample"], seg["start_sample"] + seg["speech_samples"]
            for c in e["items"]:
                if not (lo <= c["start"] < c["end"] <= hi) or c["vowel"] not in VOWELS or not 0 <= c["weight"] <= 1:
                    return f"line {n}: cue outside segment or bad vowel/weight"
        if kind == "complete":
            if e["total_samples"] != next_audio or e["segments"] != len(segments):
                return f"line {n}: totals"
            ended = True
        if kind == "cancelled":
            ended = True
    return None if ended else "stream has no complete/cancelled"


def check_v2_begin(begin):
    for key in V2_STRINGS:
        value = begin.get(key)
        if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 64:
            return f"v2 begin: {key} missing or not a string of 1-64 bytes"
    for key, low in (("clause_index", 0), ("spoken_text_revision", 1), ("turn_generation", 0)):
        value = begin.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < low:
            return f"v2 begin: {key} missing or below {low}"
    if begin.get("interrupt_policy") not in V2_POLICIES:
        return "v2 begin: interrupt_policy"
    fingerprint = begin.get("engine", {}).get("voice_fingerprint")
    if fingerprint is not None and not (isinstance(fingerprint, str) and len(fingerprint) == 64
                                        and all(c in "0123456789abcdef" for c in fingerprint)):
        return "v2 begin: engine.voice_fingerprint is not 64 lowercase hex"
    return None


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        err = check(f.readlines())
    if err:
        print(err)
    sys.exit(1 if err else 0)
