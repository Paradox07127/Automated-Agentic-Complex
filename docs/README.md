# 文档索引

[English](README.en.md) · [项目 README](../README.md)

## 使用应用

- [产品指南](product.md)介绍桌面互动、对话、任务、记忆、观察与权限。
- [发行组件](components.md)介绍 portable 与拆分构建，安装、升级和缺少组件时的表现，以及打包工具、Electron 运行时、签名权限和 Windows 便携版。
- [导入外部动作](guides/motion-import.md)介绍 VMD、BVH、glTF、GLB、VRMA、FBX 等外部动作导入与重定向限制，以及 MMD 舞蹈与背景音乐同步。
- [浏览器扩展](guides/browser-extension.md)说明 Chrome 标签页状态、可选的网页正文、隐私设置和安装步骤。
- [电脑操作](architecture/tool-gateway.md#电脑操作)说明受支持的会话如何请求访问选定的原生应用窗口。
- [部署语音服务](guides/tts-deploy.md)说明如何自部署 GPT-SoVITS 并连接到应用。

## 开发应用

- [仓库与运行架构](architecture/overview.md)说明目录分工及进程间如何通信。
- [Electron 外壳与平台 helper](architecture/shell.md)说明主进程、桌面浮层、`ac-helper`、权限与隐私规则和 Windows 差异。渲染器（Metal 宿主与 Windows `efw.exe`）是私有组件，源码不在公开仓库。
- [工具网关](architecture/tool-gateway.md)说明 agentd 如何授权、记录和撤销工具调用。
- [开发与发行](development.md)列出环境要求、开发面板、构建与测试命令、Windows 构建和发行步骤。
- [agentd](architecture/agentd.md)说明 Python 包结构、开发约定、角色主会话与可替换内核。
- [网页 UI](architecture/web-ui.md)说明前端结构、界面规则、mock 与校验。
- [角色包工具与动作生成](architecture/characters.md)说明构建工具、样例角色库、原生包打包和动作生成服务。

## 运行时接入

- [语音合成服务](architecture/voice.md)说明 GPT-SoVITS 服务的文件、令牌、口型 cue 和取消。
- [内核运行时打包](components.md#内核运行时)说明随应用打包的 Pi 运行时；Codex、Claude Code 和 ACP 智能体使用本机安装的版本。
