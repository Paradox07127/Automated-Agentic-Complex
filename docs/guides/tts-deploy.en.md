# Deploying the voice service

[简体中文](tts-deploy.md) · [Documentation index](../README.en.md)

## Overview

The GPT-SoVITS voice service is an optional service, separate from Agentic Complex.app. The app stores only the service connection, address and token; it ships no image or weights. For the service's structure, see [Speech synthesis service](../architecture/voice.en.md).

By default the port is published only on the service machine's loopback address, and only a loopback `Host` is accepted (`voice/tts-service/auth.py`). Add `--bind` at deployment to open it to other machines; see "Connecting from Agentic Complex". In the container the runtime root is `/srv/tts` (`AAC_VOICE_ROOT`) and the upstream code is in `/opt/GPT-SoVITS` (`AAC_GPT_SOVITS`); `voice/tts-service/deploy/compose.yaml` sets both.

## Preparing weights

You supply the weights, reference audio, registry and base models yourself. Neither the repository nor the image contains them, and nothing downloads them. The full inference working set is needed; two checkpoints alone are not enough:

```text
<root>/
  weights/
    pretrained_models/          # GPT-SoVITS base models, hubert, roberta
    runs/<run>/                 # selected weights plus the training config and validation records the runtime reads
    data/adaptation-v1/         # reference audio bank, needed when reference_id is used
    models/nltk_data/
    tools/frontend_lexicon.py  # only for voices with game_lexicon enabled
  state/
    tts-registry.json
    tts-token                   # created by deploy.sh when missing
```

In the container, `weights/` is `/srv/tts` and `state/` is `/srv/tts/state`. Absolute paths in the training config, validation records and reference audio list must also point at these container paths, including `output_dir` and `train.half_weights_save_dir` in `s1.yaml` and the reference audio's `wav`. Copy only the files the runtime needs; do not copy training sets or other evaluation models as deployment dependencies. The container mounts weights and state read-only. It writes inference configs, verification records and generated audio to `<root>/output/<run>/`.

## Starting

The service machine needs an NVIDIA GPU, a driver that supports CUDA 12.8, Docker Engine, the Compose v2 plugin, the NVIDIA Container Toolkit, and Python 3 to create the token. The `Dockerfile` pins the GPT-SoVITS commit, the CUDA image digest, an Ubuntu apt snapshot and the torch/torchaudio cu128 versions. Python packages install only from `voice/tts-service/requirements-tts.lock`, every file hash-checked; the source-only ones are compiled in the image.

Run from the repository root (or from another directory with the script's full path):

```sh
bash voice/tts-service/deploy/deploy.sh --root /srv/agentic-complex-tts --port 9888
```

`--root` must be a data directory the current user can write; `--port` is the host port. Run it as the non-root service account. The script creates `weights/`, `state/` and `output/`, then builds the image and starts the Compose service. The container runs with the UID/GID of the user who ran the script, so the token file stays owned by the service process user.

When no token exists, the script creates `<root>/state/tts-token` with `secrets.token_urlsafe(32)` and mode 0600; an existing file is left unchanged. The output shows only the file location, not the token. Open the file on that machine and enter the token in Agentic Complex. Keep this `state` directory, and restarting the service needs no new token. At startup the service refuses a token file that is missing, blank, too permissive, owned by another user, or a symlink.

## Connecting from Agentic Complex

In Settings › 服务 (Services), set how TTS connects; then, in Settings › 说话与通知 (Speech and notifications), fill in 令牌 (Token) and click 测试连接 (Test connection). `GET /health` needs no token; synthesis requests carry `Authorization: Bearer <token>`. There are four connections: off, address, SSH, local. For the fields and validation, see the [shell](../architecture/shell.en.md#external-services).

### Same machine: local or address

When the service and Agentic Complex are on the same machine, choose Address and enter `http://127.0.0.1:<port>`. You can also choose Local, where Agentic Complex runs the start command, with the same loopback address.

### SSH

When the service is on another machine, choose SSH and enter the SSH host and `http://127.0.0.1:<port>`. Agentic Complex runs `ssh -N -L <port>:127.0.0.1:<port> <host>`, so the local and remote ports are the same; the service's remote port must equal this `<port>`. The host must allow login without a password (`BatchMode`).

### On-demand start script

Under SSH you can also enter the path of a start script on the remote host. When TTS is not up, Agentic Complex and agentd run:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=5 -- <host> <script> ensure
```

The script does one thing by its first argument and answers on standard output:

| Argument | What it does | First reply line |
|---|---|---|
| `ensure` | Starts the service if it is not up and waits until it is usable | `ready <seconds>` or `fail <reason>` |
| `stop` | Stops the service | `stopped` or `fail <reason>` |
| `status` | Only looks | `running …` or `stopped` |

A minimal example (it shows only the input and output; you write `start_service`, `stop_service` and `service_up`):

```sh
case "$1" in
  ensure) service_up || start_service
          service_up && echo "ready 20" || echo "fail start_timeout" ;;
  stop)   stop_service && echo stopped || echo "fail stop_error" ;;
  status) service_up && echo "running pid=1234" || echo stopped ;;
esac
```

When you save a record with a script, Agentic Complex first asks for confirmation, naming the host the script will run on.

### Direct LAN connection

Add `--bind 0.0.0.0` (or the IPv4 address of one of the machine's interfaces) at deployment:

```sh
bash voice/tts-service/deploy/deploy.sh --root /srv/agentic-complex-tts --port 9888 --bind 0.0.0.0
```

The script then makes the service accept any `Host`. In Settings › 服务 (Services), choose Address and enter `http://<service machine address>:<port>`; the token is still required.

## Manual deployment

Without Docker, put the code of `voice/tts-service/` on the TTS host and run `python serve_tts.py [port]` with a Python that has the GPT-SoVITS dependencies installed. Set these before starting:

- `AAC_TTS_TOKEN_FILE`: the token file, for example `<TTS root>/state/tts-token`. To create a token:

  ```sh
  python3 -c "import secrets;print(secrets.token_urlsafe(32))" > <TTS root>/state/tts-token && chmod 600 <TTS root>/state/tts-token
  ```

- `AAC_VOICE_ROOT`: the TTS root, default `/srv/tts`, laid out like `weights/` above. Voices with `game_lexicon` enabled import `frontend_lexicon.py` from `<TTS root>/tools/`.
- `AAC_GPT_SOVITS`: the GPT-SoVITS code directory, default `<TTS root>/GPT-SoVITS`.

Copy `protocol/C2-speech-stream/phone-vowel-map.json` flat into the directory of `serve_tts.py`; the service reads the mapping table from there.

## MFA (optional)

With the environment variable `AAC_MFA_PYTHON=<mfa-env>/bin/python` set, the service starts one `mfa_worker.py` subprocess with that interpreter at startup. It preloads the Chinese and Japanese gsvlex dictionaries and acoustic models, and all streams share it. Without it, MFA is off and only revision 1 mouth cues are sent.

The acoustic models default to `<TTS root>/models/mfa_root`; `MFA_ROOT_DIR` changes this. The generated dictionaries and FST cache go to `mfa-lexicon/` next to `mfa_worker.py`. The main service process gets no new dependencies: kalpy and MFA are installed only in the subprocess environment, with versions in `voice/tts-service/requirements-mfa.lock`.

## Debugging

With `AAC_TTS_KEEP_FILES=1`, the streaming endpoints write a WAV, `.timing.json` and `.metrics.json` per request into `output/<run>/`. By default they write nothing; `/synthesize` always writes.

## Limits

- The image contains no MFA environment, so a Docker deployment sends only MRTE revision 1 cues.
- The image configures no TLS. With a direct LAN connection the traffic is plaintext, and the token and speech text are visible on the network; use it only on a network you trust.
