# TTS 令牌（C2 v2 §4 的 agentd 侧做法）

- 令牌文件只有一份在 Mac 上：`~/Library/Application Support/local.agenticcomplex.companion/tts-token`（0600）。agentd 读 Companion 用 `--tts-token-file` 传来的这个路径（C10）。`AAC_TTS_TOKEN_FILE` 可以改路径。
- 生成：`agent/agentd/tools/tts_token.py ensure`。文件已存在就不动；只打印路径，不打印令牌。
- 拷到 TTS 主机：`agent/agentd/tools/tts_token.py push --ssh <主机>`。令牌走 ssh 的标准输入，不出现在命令行；TTS 主机上写到 `<TTS 根目录>/state/tts-token`（0600，先写 `.new` 再改名）。
- 轮换：`agent/agentd/tools/tts_token.py rotate --ssh <主机>`。先写 TTS 主机，成功后才换本地文件；拷贝失败时两边都还是旧令牌。
- TTS 主机上的服务只在启动时读令牌：push 或 rotate 之后要重启 TTS 服务和 agentd。
- agentd 请求 TTS 时带 `Authorization: Bearer <令牌>`；读不到令牌时照样发请求，TTS 回 401，agentd 发 `speech.failed`，不卡在说话状态。
