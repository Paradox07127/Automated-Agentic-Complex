# 外部 agent 接入（`/integration/*`）

外部 agent 和插件经 `agentic-complex` 程序（`agent/agentd/tools/agentic_complex.py`）调这 6 条路由：`agentic-complex mcp` 是 stdio MCP 服务，其余子命令各对应一条路由。处理模块是 `agent/agentd/api/integration.py`。

## 令牌

- 只认 `integration_token`。agentd 每次启动重新生成，和 `ui-runtime.json` 一样在 publishing 阶段写 `<state-dir>/integration-runtime.json`（0600）：`{"schema": 1, "base_url": "http://127.0.0.1:<port>", "integration_token": "…"}`。
- `integration_token` 调不到其余任何路由（401）；`ui_token`、`hook_token`、`events_token` 调不到这 6 条（401）。网页类是 `integration_only`，外壳的桥一律拒绝。
- 外部只能提议：出卡、开提醒审批卡、写记忆候选。批准、拒绝、确认记忆只走界面（`ui_token`）。

## 共同字段

- POST 请求体是 JSON 对象，多出的键回 400 `invalid_payload`。
- `source`：可选，发起方的名字，`[A-Za-z0-9._-]{1,40}`，缺省 `external`。MCP 服务填客户端 `initialize` 报的 `clientInfo.name`。

## `POST /integration/notify`

请求 `{"text": "…", "source"?}`，`text` 1–2000 字、不能全是空白。

- 闸门（类别 `integration_notice`，级别 P2）放行、没开安静模式、角色在屏上，且角色此刻不在说话：她用自己的话转述，回 200 `{"delivered": "voice"}`。`text` 和 `source` 只作本轮的观察材料，不进指令；这一句计入闸门的每日条数和冷却。
- 否则在卡片栈出一张简报卡，标题 `[<source>] <text>`，不念出来，回 200 `{"delivered": "card", "reason": "<原因>"}`。原因是闸门的拒绝原因（`meeting`、`quiet_hours`、`focus`、`daily_limit` 等）、`quiet`（安静模式）、`hidden`（角色不在屏上）或 `busy`（正在说话或内核没准备好）。

## `POST /integration/reminders`

请求 `{"text": "…", "due_at": <Unix 秒>, "source"?}`，`text` 1–200 字，`due_at` 在现在之后、366 天以内。

开一张审批卡（`GET /approvals` 里 `tool_name` 为 `reminder`，`tool_summary` 为本地时间 `YYYY-MM-DD HH:MM` 加 `text`，`source` 为发起方），等用户 600 秒。回 202 `{"request_id": "…", "state": "pending", "expires_in_s": 600}`。用户批准后才建提醒（和「提醒我…」建的一样，feed 发 `commitment` `added`）。没有提醒存储时 503 `no_commitments`。

## `GET /integration/reminders/<request_id>`

回 200 `{"request_id", "state", "commitment_id"}`。`state`：`pending`、`accepted`（`commitment_id` 是新提醒的 id）、`declined`、`expired`（过时、被撤或 agentd 关闭）。agentd 只记最近 256 个提议，重启后全部忘记；不认识的 id 回 404 `unknown_request`。

## `GET /integration/memory?q=<文字>&limit=<1–10>`

只在生效的共享记忆里按双字重合度找，分数不到 0.15 的不回；`limit` 缺省 5。回 200 `{"facts": [{"text", "kind", "source", "recorded_at"}]}`，`source` 是可信度（`asserted_by_user`、`confirmed_by_user`、`observed_context`、`inferred_hypothesis`）。候选不回。携带 `owner`、`q` 为空或 `limit` 越界回 400 `invalid_query`。

## `POST /integration/memory`

请求 `{"text": "…", "kind"?, "source"?}`，`text` 1–500 字，`kind` 为 `fact`（缺省）、`preference` 或 `experience`。

写一条候选（来源 `inferred_hypothesis`，evidence `["integration:<source>"]`），在记忆页等用户确认或拒绝，不进任何一轮的上下文。回 201 `{"fact_id", "state": "candidate"}`；记忆暂停时什么也不写，回 200 `{"paused": true}`；用户删过或拒过同样的文字回 409 `rejected_before`。

## `GET /integration/timeline?since=<Unix 秒>&until=<Unix 秒>`

`until` 缺省现在，`since` 缺省 `until` 前 1 小时，跨度不超过 24 小时（原始时间线只留一天）。回 200：

```json
{"since": 0, "until": 0, "paused": false,
 "segments": [{"start": 0, "end": 600,
               "apps": [{"app": "Code", "seconds": 180, "titles": ["main.py — Agentic Complex"], "hosts": []}]}]}
```

- 每个有焦点时长的 10 分钟段一项，按时间先后。一条 `window` 记录占焦点到下一条 `window` 记录为止，最后一条到 `until` 为止，可以跨段；`since` 之前最后一条 `window` 记录从 `since` 起算。`seconds` 是段内这些时长之和。每个 app 最多 3 个不同的窗口标题（各截到 120 字）和 3 个域名。
- 不回键入文字、目标控件、按键和窗口树。黑名单此刻隐藏的记录不算（`observation/timeline.py` 的 `records`），它们的时长算进前一个窗口。
- 观察暂停中（含会议模式）回 `"paused": true` 和空的 `segments`。
- 参数不是有限数字、`since >= until` 或跨度超过 24 小时回 400 `invalid_query`；没有时间线存储时 503 `no_timeline`。
