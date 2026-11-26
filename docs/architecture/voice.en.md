# Speech synthesis service

[简体中文](voice.md) · [Documentation index](../README.en.md)

## Overview

`voice/tts-service/` is an HTTP speech synthesis service based on GPT-SoVITS. It runs on a TTS host with an NVIDIA GPU. agentd sends text to `POST /speech_stream`. For deployment and connection, see [Deploying the voice service](../guides/tts-deploy.en.md).

## Files

| File | Contents |
|---|---|
| `serve_tts.py` | FastAPI service. `python serve_tts.py [port] [--listen-address ADDR]`; default port 9888, default address `127.0.0.1` |
| `auth.py` | Reads the token file; the ASGI middleware `TokenAuth` checks `Host` and the Bearer token |
| `model_residency.py` | Keeps one model resident at a time; checks free GPU memory before a load and answers HTTP 503 when it is short |
| `tts_runtime.py` | Loads the selected weights in `<TTS root>/runs/<run>/` and synthesizes; installs `SegmentRecorder` |
| `segment_meta.py` | Segment metadata recording (`SegmentRecorder`, including MRTE attention capture) and C2 event generation (`C2Stream`) |
| `cues.py` | `cues` events: MRTE Viterbi (revision 1), phone→vowel mapping, the MFA subprocess client (`MfaClient`) and per-stream cue handling (`CueStream`). Standard library and numpy only |
| `mfa_worker.py` | MFA subprocess (kalpy in-process alignment, CPU, beam 10); one JSON object per line on stdin/stdout |
| `requirements-mfa.lock` | Explicit Linux Conda artifact URLs and MD5 hashes for the MFA subprocess environment |
| `test_*.py` | Unit tests with a fake engine and a fake MFA subprocess |
| `deploy/` | Docker deployment: `Dockerfile`, `compose.yaml`, `deploy.sh` |

## Endpoints

| Endpoint | Format |
|---|---|
| `POST /speech_stream` | C2 speech stream; the response is `application/x-ndjson`, one C2 event per line |
| `GET /health` | Service status; without a valid token it holds only `status` |
| `POST /synthesize`, `POST /synthesize_stream`, `GET /artifacts/{id}/{audio,timing}` | Older format. `/synthesize` writes a WAV and returns `audio_url`; `/synthesize_stream` writes no files by default |

## Connection and token

- At startup the service reads the token from the file named by the environment variable `AAC_TTS_TOKEN_FILE`, and refuses to start when it is not set. The file is opened with `O_NOFOLLOW` and checked with `fstat`. The service refuses to start when the file is missing, empty, a symlink, not owned by the current user, or has any group/other permission bit.
- HTTP and WebSocket requests are checked for `Host` first. Only `127.0.0.1`, `localhost` and `[::1]` (optionally with a port) are accepted. Other values get HTTP 400 (`{"detail":"Invalid host header"}`); a WebSocket is closed with 1008 before accept. With the environment variable `AAC_TTS_REMOTE=1`, any `Host` is accepted.
- Except `GET /health`, every HTTP request and every WebSocket must carry `Authorization: Bearer <token>`; the token is compared in constant time. A missing or wrong token gets HTTP 401 (`{"detail":"Unauthorized"}`); a WebSocket is closed with 1008 before accept and no stream starts.

## Mouth cues

`/speech_stream` sends `speech.begin` first. Then, for each sentence fragment, it sends `segment`, that segment's `audio`, and that segment's revision 1 `cues`, in that order.

| revision | source | Method | `confidence` |
|---|---|---|---|
| 1 | `mrte-attn` | During synthesis a hook on `enc_p.mrte.cross_attention` takes the target sentence's attention; a monotonic Viterbi finds each phone's frame span (head 0 for Chinese, the mean of the 4 heads for Japanese; pauses only at fragment edges and punctuation). One frame is 960 samples | The phone's mean attention over its frames, [0,1] |
| 2 | `mfa` | `mfa_worker.py` runs MFA alignment on the speech part of the segment (without the tail silence) and maps the result back to GSV phones. Beam 10 only; a failed alignment is not retried | 1.0 |

- MFA is enabled only when `AAC_MFA_PYTHON` is set (see [Deploying the voice service](../guides/tts-deploy.en.md)). Revision 2 is sent when the MFA reply arrives and can fall between lines of later fragments. The client replaces a segment's cues as a whole with the higher revision.
- After synthesis ends, the service waits at most 5 more seconds for the MFA replies this stream has submitted, then sends `complete`. When a segment's reply did not arrive, `cues_complete` is `false`, and replies arriving later are dropped. `complete.result.cue_warnings` lists the segments without revision 2: `error` is `beam` (beam 10 failed), `mfa_timeout` (timed out), or another error the MFA subprocess reported. Those segments have revision 1 only.
- Segments that mix in English: GSV splits the text into parts by language. The service records each part's language and phone span, used only inside the service and in the MFA request, not in the C2 `segment`. The MFA transcript has one `<unk>` per English part, absorbed by the acoustic model's `spn` phone; there are no revision 2 cues during English. MRTE treats English phones as ordinary phone columns, not as silence.
- Both revisions emit only phones present in `protocol/C2-speech-stream/phone-vowel-map.json`, with `vowel` and `weight` from the table. Spans are clipped to the segment's speech range; empty spans are dropped.
- `seq` is assigned and queued under one lock, so `seq` still rises in output order when the synthesis thread and the MFA reply threads interleave.
- The service checks each fragment: the phones the vocoder consumed match the recorded text segment; the fragment's sample count equals `1920 × semantic tokens + tail silence`; the MRTE attention shape matches. On a mismatch the stream ends with `cancelled{reason:"error"}` and sends no wrong metadata.

## Cancellation

After the client disconnects (the same for `/speech_stream` and `/synthesize_stream`), synthesis stops at the next write, before the next semantic token (`ar_predict_layer` in each T2S step), or before the next CFM step. It then releases the GPU lock and the next queued request starts. Work already queued on the GPU runs to completion first. Late MFA replies are dropped.

## Tests

The unit tests need numpy only, not torch or kalpy:

```sh
cd voice/tts-service && ../../agent/.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```
