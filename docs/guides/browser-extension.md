# 浏览器扩展

[English](browser-extension.en.md) · [文档索引](../README.md)

## 概述

Chrome MV3 扩展 `agent/browser/extension` 经 Native Messaging 把普通窗口的标签页状态交给本机 agentd。控制面板的「浏览器与网站」面板显示统计。扩展、native host 和 agentd 之间的消息格式见 [agentd](../architecture/agentd.md#浏览器扩展消息)。

## 采集范围与隐私

- 权限只有 `tabs`、`alarms`、`nativeMessaging`、`storage`；不申请 history、cookies、downloads、debugger 或 scripting。无痕窗口不运行。内容脚本只匹配 HTTP(S) 页面。
- 域名、标题、是否发声、窗口聚焦和文档身份构成注意力心跳。完整 URL 只在扩展本次运行的内存和 `storage.session` 里用来判断导航，不发给 agentd；关闭标签后删掉身份状态。
- 设置里的「读取网页正文」（`share_page_text`，默认关）同时控制正文与选区的采集和模型分享。关着时扩展不读正文和选区，native host 和 agentd 也拒收这两类文字。关掉开关不会自动删掉已有记录，可以用清空注意力或忘记近期删除。
- 开启后，正文取 article、main 或 body 里的可见文字，最多 2000 字符。跳过表单、输入框、可编辑区域、脚本、样式和隐藏元素，不读输入值。选区经过同样的可编辑区域检查。
- 数值包括当前和最远滚动百分比、可读取的音视频状态（播放、暂停、缓冲、结束、进度、时长、倍速、静音），以及普通标签数和非黑名单发声标签数。不读媒体 URL、字幕、音轨、观看历史或后台标签的正文。
- 数值只给本机控制面板用。agentd 只在内存里留最新一份，15 秒过期；不写 SQLite，不进活动判断或模型上下文。网站时长沿用 7 天的注意力时间线。
- native host 每次采样前先取 agentd 的实时策略；agentd 没运行、观察暂停、重置、锁屏、睡眠或安全输入期间不采集。取策略失败时停止采集。黑名单域名和标题在扩展、host 和 agentd 三处过滤。
- 锁屏、休眠或安全输入时，agentd 立即结束浏览器的前台区间，并拒收在途数据；当前正文和选区要重新采样后才能再用。扩展采样中断超过 15 秒或 native host 重连时，重新等前台停留并刷新正文，丢掉跨过长空档的异步结果。

## 统计口径

前台页面每 5 秒合并采样一次；切标签、导航、标题、发声、窗口焦点变化时立即采样。失焦心跳结束前台区间，失焦后旧正文和选区不再算当前页。没有页面时也会关闭最后一个前台区间。每分钟一次的 alarm 是没有内容脚本时的心跳后备。

在前台停留至少 5 秒后才取正文。DOM 变化只做标记，采样时再读；同一页面的正文变化会增加 revision。正文清空会让旧正文失效。没变化时不重复发，持续停留时每 5 分钟刷新一次。异步结果会重新核对焦点、标签、URL、标题和采样序号。

- 网站时长：前台窗口 ∩ 活跃时间；发声页面只在窗口聚焦时能补充 AFK 区间。未知空档不填充，最多显示时长前 20 个网站。
- 页面切换数：今天记录到的前台文档或标签切换的估计，正文 revision 更新不算切页；它不是完整的访问历史。
- 滚动百分比：顶层文档的滚动位置，不等于已读；没有滚动范围时显示不可用。内嵌滚动容器、iframe 和封闭 shadow DOM 不覆盖。
- 媒体：优先取正在播放的标准 video、audio 元素，否则取可见的那个。顶层播放器引用跨域媒体资源时仍有数值；播放器在跨域 iframe 里时不注入、不读取，返回没有可读媒体状态，不能据此断定网页没在播放。特殊播放器、Web Audio 和受保护内容也可能没有可读状态。无限时长显示未知。

## 安装与更新

1. 构建 Companion：`bash app/build_app.sh`。
2. 第一次安装时运行 `sh agent/browser/install.sh [state-dir]`（只支持 macOS；默认 state-dir 是 `~/Library/Application Support/AgenticComplex/agentd`）。它写入 `<state-dir>/native-host.sh` 和 Chrome 的 NativeMessagingHosts 清单 `local.agenticcomplex.agentd.json`，host 用仓库里 `agent/.venv` 的 Python。已有安装不需要重写。
3. 在 Chrome 的 `chrome://extensions` 打开开发者模式，加载或重新加载 `agent/browser/extension`。扩展 id 固定为 `oahafcajijleoficnkbfaedkmnkhnief`。
4. 刷新已经打开的网页，让新的内容脚本生效。

重载扩展不会替换旧网页里已经注入的内容脚本。内容脚本在扩展环境失效后会停掉定时器、DOM 观察和事件监听，并清空文字缓存。如果旧脚本已经报了 `Extension context invalidated`，刷新或关闭对应网页；扩展管理页里的历史错误记录可以手动清空。
