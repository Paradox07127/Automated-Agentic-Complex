"""Synthesize one silent test clause and check the service's C2 stream."""
import base64
import http.client
import json
import secrets
import time
import uuid

from voice.speech import endpoint


def check(url, token, character, language, timeout=30):
    result = {"ok": False, "first_audio_ms": None, "total_ms": None, "reason": None}
    try:
        parts = endpoint(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        result["reason"] = "invalid_url"
        return result
    base = parts.path.rstrip("/")
    utterance_id = secrets.token_hex(6)
    body = json.dumps({"character": character, "language": language, "text": "你好。",
                       "allow_unvalidated_pilot": True, "accelerated": True,
                       "session_epoch": str(int(time.time())), "turn_id": secrets.token_hex(6),
                       "speech_id": secrets.token_hex(6), "expires_at_ms": int(time.time() * 1000) + 120_000,
                       "utterance_id": utterance_id, "clause_id": f"{utterance_id}.c0", "clause_index": 0,
                       "spoken_text_revision": 1, "voice_profile_id": f"{character}.{language}.default",
                       "interrupt_policy": "immediate", "turn_generation": 0, "trace_id": str(uuid.uuid4())}).encode()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    connection = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = connection(parts.hostname, port, timeout=timeout)
    try:
        conn.request("GET", f"{base}/health", headers=headers)
        response = conn.getresponse()
        if response.status != 200:
            result["reason"] = f"http_{response.status}"
            return result
        response.read()
        started = time.monotonic()
        conn.request("POST", f"{base}/speech_stream", body, {**headers, "Content-Type": "application/json"})
        response = conn.getresponse()
        if response.status != 200:
            result["reason"] = f"http_{response.status}"
            return result
        first, samples = True, 0
        for raw in response:
            line = json.loads(raw)
            if not isinstance(line, dict):
                raise ValueError
            event = line.get("event")
            if first:
                clock = line.get("clock")
                if event != "speech.begin" or line.get("schema") not in ("endfield-speech-timeline-v1",
                                                                         "endfield-speech-timeline-v2") \
                        or not isinstance(clock, dict) or clock.get("sample_rate") != 48000 \
                        or line.get("format") != "pcm_s16le" or line.get("channels") != 1:
                    raise ValueError
                first = False
            elif event == "audio":
                if type(line.get("start_sample")) is not int or line["start_sample"] != samples \
                        or type(line.get("samples")) is not int or line["samples"] < 0:
                    raise ValueError
                pcm = line.get("pcm_base64")
                if not isinstance(pcm, str) or not pcm or len(base64.b64decode(pcm, validate=True)) != 2 * line["samples"]:
                    raise ValueError
                if result["first_audio_ms"] is None:
                    result["first_audio_ms"] = int((time.monotonic() - started) * 1000)
                samples += line["samples"]
            elif event == "complete":
                if type(line.get("total_samples")) is not int or line["total_samples"] != samples or not samples:
                    raise ValueError
                result.update(ok=True, total_ms=int((time.monotonic() - started) * 1000))
                return result
            elif event not in ("segment", "cues"):
                raise ValueError
        result["reason"] = "bad_stream"
    except TimeoutError:
        result["reason"] = "timeout"
    except OSError:
        result["reason"] = "unreachable"
    except (ValueError, http.client.HTTPException):
        result["reason"] = "bad_stream"
    finally:
        conn.close()
    return result
