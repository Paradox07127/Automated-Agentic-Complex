# 部署语音服务

[English](tts-deploy.en.md) · [文档索引](../README.md)

## 概述

GPT-SoVITS 语音服务是独立于 Agentic Complex.app 的可选服务。应用只保存服务地址和令牌，不携带镜像或权重。服务的结构见[语音合成服务](../architecture/voice.md)。

默认只在服务机器的回环地址上发布端口，并且只接受回环 `Host`（`voice/tts-service/auth.py`）。部署时加 `--bind` 才对别的机器开放，见「从 Agentic Complex 连接」。容器里的运行时根目录是 `/srv/tts`（`AAC_VOICE_ROOT`），上游代码在 `/opt/GPT-SoVITS`（`AAC_GPT_SOVITS`），`voice/tts-service/deploy/compose.yaml` 已设好。

## 准备权重

权重、参考音、注册表和底模需要自行准备；仓库和镜像不包含这些资源，也不自动下载它们。需要完整的推理工作集，单独两个 checkpoint 不够：

```text
<root>/
  weights/
    pretrained_models/          # GPT-SoVITS 的底模、hubert、roberta
    runs/<run>/                 # 已选权重及运行时读取的训练配置和验证记录
    data/adaptation-v1/         # 使用 reference_id 时需要的参考音库
    models/nltk_data/
    tools/frontend_lexicon.py
  state/
    tts-registry.json
    tts-token                   # deploy.sh 在缺失时创建
```

容器内 `weights/` 对应 `/srv/tts`，`state/` 对应 `/srv/tts/state`。训练配置、验证记录和参考音清单里的绝对路径也必须对应这些容器路径，包括 `s1.yaml` 的 `output_dir`、`train.half_weights_save_dir` 和参考音的 `wav`。只放运行时需要的文件，不要把训练集或其他评测模型当作部署依赖复制进去。权重卷要可写，因为运行时会在 `runs/<run>/` 里写推理配置和 checkpoint 验证记录。

## 启动

服务机器需要 NVIDIA GPU、支持 CUDA 12.8 的驱动、Docker Engine、Compose v2 插件、NVIDIA Container Toolkit，以及用于创建令牌的 Python 3。镜像在 `Dockerfile` 里固定 GPT-SoVITS 提交、torch/torchaudio cu128 版本和 Python 依赖清单。

在仓库根目录运行（也可从其他目录用脚本的完整路径运行）：

```sh
bash voice/tts-service/deploy/deploy.sh --root /srv/agentic-complex-tts --port 9888
```

`--root` 必须是当前用户可写的数据目录；`--port` 是主机端口。脚本创建 `weights/`、`state/`，随后构建镜像并启动 Compose 服务。容器使用运行脚本的 UID/GID，令牌文件因此仍属于服务进程用户。

令牌不存在时，脚本用 `secrets.token_urlsafe(32)` 创建 `<root>/state/tts-token`，权限为 0600；已有文件保持不变。输出只显示文件位置，不显示令牌内容。你在本机打开这个文件，把令牌填进 Agentic Complex。保留这个 `state` 目录，重启服务就不需要更换令牌。服务启动时拒绝缺失、空白、权限过宽、所有者不符或是符号链接的令牌文件。

## 从 Agentic Complex 连接

在「设置 › 说话与通知」填「服务地址」和「令牌」，点「保存」，再点「测试连接」。`GET /health` 不需要令牌；合成请求带 `Authorization: Bearer <token>`。

### 同一台机器或 SSH 转发（默认）

服务和 Agentic Complex 在同一台机器上时，服务地址填 `http://127.0.0.1:<port>`。在不同机器上时，在 Mac 上保持这个命令运行：

```sh
ssh -N -L 19888:127.0.0.1:9888 user@host
```

远端的 `9888` 换成部署时的主机端口；Agentic Complex 的服务地址填 `http://127.0.0.1:19888`。

### 局域网直连

部署时加 `--bind 0.0.0.0`（或这台机器某个网卡的 IPv4 地址）：

```sh
bash voice/tts-service/deploy/deploy.sh --root /srv/agentic-complex-tts --port 9888 --bind 0.0.0.0
```

脚本因此让服务接受任意 `Host`。Agentic Complex 的服务地址填 `http://<服务机器地址>:<port>`，令牌仍然必须填。

## 手动部署

不用 Docker 时，把 `voice/tts-service/` 的代码放到 TTS 主机上，用装好 GPT-SoVITS 依赖的 Python 运行 `python serve_tts.py [port]`。启动前设好：

- `AAC_TTS_TOKEN_FILE`：令牌文件，例如 `<TTS 根目录>/state/tts-token`。建令牌：

  ```sh
  python3 -c "import secrets;print(secrets.token_urlsafe(32))" > <TTS 根目录>/state/tts-token && chmod 600 <TTS 根目录>/state/tts-token
  ```

- `AAC_VOICE_ROOT`：TTS 根目录，默认 `/srv/tts`，布局同上面的 `weights/`。`frontend_lexicon.py` 从 `<TTS 根目录>/tools/` 引用。
- `AAC_GPT_SOVITS`：GPT-SoVITS 代码目录，默认 `<TTS 根目录>/GPT-SoVITS`。

把 `protocol/C2-speech-stream/phone-vowel-map.json` 平铺拷到 `serve_tts.py` 所在目录；服务从那里读映射表。

## MFA（可选）

设环境变量 `AAC_MFA_PYTHON=<mfa-env>/bin/python` 后，服务启动时用这个解释器起一个 `mfa_worker.py` 子进程，预载中日两套 gsvlex 词典和声学模型，所有流共用。没设就不启用 MFA，只发 revision 1 的口型 cue。

声学模型默认取 `<TTS 根目录>/models/mfa_root`，可用 `MFA_ROOT_DIR` 改；生成的词典和 FST 缓存在 `mfa_worker.py` 旁边的 `mfa-lexicon/`。服务主进程不加新依赖：kalpy 和 MFA 只装在子进程的环境里，版本见 `voice/tts-service/requirements-mfa.lock`。

## 调试

设 `AAC_TTS_KEEP_FILES=1` 时，流式端点每个请求在 `runs/<run>/inference/` 写 WAV、`.timing.json` 和 `.metrics.json`。默认不写；`/synthesize` 总是写。

## 限制

- 镜像不包含 MFA 环境，Docker 部署的服务只发 MRTE 的 revision 1 cue。
- 镜像不配置 TLS。局域网直连时流量是明文的，令牌和语音文本在网络上可见；只在自己信任的网络里这样用。
