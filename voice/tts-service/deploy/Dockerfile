FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates ffmpeg git libsndfile1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" PYTHONUNBUFFERED=1

RUN git clone https://github.com/RVC-Boss/GPT-SoVITS.git /opt/GPT-SoVITS \
    && git -C /opt/GPT-SoVITS checkout --detach 1b47ca07ef43a284e0b8bd7f29d3e1e3ff76082a
RUN python -m pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128 \
    && python -m pip install --no-cache-dir -r /opt/GPT-SoVITS/requirements.txt -r /opt/GPT-SoVITS/extra-req.txt \
    && python -m pip install --no-cache-dir resampy==0.4.3

RUN rm -rf /opt/GPT-SoVITS/GPT_SoVITS/pretrained_models \
    && ln -s /srv/tts/pretrained_models /opt/GPT-SoVITS/GPT_SoVITS/pretrained_models
WORKDIR /opt/tts-service
COPY voice/tts-service/serve_tts.py voice/tts-service/tts_runtime.py voice/tts-service/auth.py \
    voice/tts-service/model_residency.py voice/tts-service/segment_meta.py voice/tts-service/cues.py ./
COPY protocol/C2-speech-stream/phone-vowel-map.json ./
ENV AAC_TTS_TOKEN_FILE=/srv/tts/state/tts-token
EXPOSE 9888
CMD ["python", "serve_tts.py", "9888", "--listen-address", "0.0.0.0"]
