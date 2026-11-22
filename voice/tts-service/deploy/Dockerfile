FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04@sha256:c900a2ac7f3d860c854f7364eadfe32b8cd33933a838f96b71e9bb6525f77a8c

RUN rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources \
    && for suite in jammy jammy-updates jammy-security; do \
         echo "deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/ $suite main universe"; \
       done > /etc/apt/sources.list \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates ffmpeg git libsndfile1 python3 python3-dev python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" PYTHONUNBUFFERED=1

RUN git clone https://github.com/RVC-Boss/GPT-SoVITS.git /opt/GPT-SoVITS \
    && git -C /opt/GPT-SoVITS checkout --detach 1b47ca07ef43a284e0b8bd7f29d3e1e3ff76082a
COPY voice/tts-service/requirements-tts.lock /tmp/requirements-tts.lock
RUN python -m pip install --no-cache-dir --require-hashes --no-deps --no-binary=opencc --extra-index-url https://download.pytorch.org/whl/cu128 -r /tmp/requirements-tts.lock

RUN rm -rf /opt/GPT-SoVITS/GPT_SoVITS/pretrained_models \
    && ln -s /srv/tts/pretrained_models /opt/GPT-SoVITS/GPT_SoVITS/pretrained_models
WORKDIR /opt/tts-service
COPY voice/tts-service/serve_tts.py voice/tts-service/tts_runtime.py voice/tts-service/auth.py \
    voice/tts-service/model_residency.py voice/tts-service/segment_meta.py voice/tts-service/cues.py ./
COPY protocol/C2-speech-stream/phone-vowel-map.json ./
ENV AAC_TTS_TOKEN_FILE=/srv/tts/state/tts-token
EXPOSE 9888
CMD ["python", "serve_tts.py", "9888", "--listen-address", "0.0.0.0"]
