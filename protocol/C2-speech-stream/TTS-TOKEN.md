# TTS 令牌（C2 v2 §4 的 agentd 侧做法）

- macOS 使用登录钥匙串，Windows 使用当前用户 DPAPI。`--tts-token-file` 指定凭据引用的基础路径（C10），后缀 `.ref` 的文件只含引用标识。
- 生成凭据请运行 `agent/agentd/tools/tts_token.py ensure`。已有凭据会保留，输出为引用文件路径。
- 拷到 TTS 主机：`agent/agentd/tools/tts_token.py push --ssh user@host --remote /srv/agentic-complex-tts/state/tts-token`。令牌走 ssh 的标准输入，不出现在命令行；TTS 主机上写到 `<TTS 根目录>/state/tts-token`（0600，先写 `.new` 再改名）。
- 轮换：`agent/agentd/tools/tts_token.py rotate --ssh user@host --remote /srv/agentic-complex-tts/state/tts-token`。先写 TTS 主机，成功后才换本地凭据；拷贝失败时两边都还是旧令牌。
- TTS 主机上的服务只在启动时读令牌：push 或 rotate 之后要重启 TTS 服务和 agentd。
- agentd 请求 TTS 时带 `Authorization: Bearer <令牌>`；未配置令牌时照样发请求，TTS 回 401，agentd 发 `speech.failed`，不卡在说话状态。
