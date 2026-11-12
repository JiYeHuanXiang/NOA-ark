# NOA-onebot 使用手册（动作与能力）

> 对应实现：`src/onebot/actions.ts`（动作）、`src/onebot/events.ts`（事件）、`src/onebot/server.ts` / `reverse.ts`（通信）。
> 版本：0.1.0（一期骨架）。能力边界与映射依据见 [文档.md](文档.md)。
> 本手册描述**当前实现**（`src/onebot/actions.ts`，快照时间：2026-11-12）；文档 §3.3 是协议映射与设计目标，部分条目尚未落地。

---

## 1. 连接方式

NOA-onebot **只提供 WebSocket**（HTTP API 与 HTTP POST 上报已移除）。所有动作与事件共用同一条连接。

| 方式 | 说明 |
|---|---|
| 反向 WS（推荐） | 适配器主动连接旧程序，配置 `onebot.reverseUrls[]`（如 `ws://127.0.0.1:6700`）。连上后立即推送 lifecycle，之后双向收发。 |
| 正向 WS | 旧程序连接 `ws://127.0.0.1:7791/ws`（端口/路径由 `onebot.wsPort` / `onebot.wsPath` 决定）。 |
| 普通 HTTP | 一律返回 `426 Upgrade Required`，没有 HTTP API。 |

**鉴权**：`Authorization: Bearer <accessToken>` 或 `?access_token=<accessToken>`；`accessToken` 为空表示不鉴权（仅限本机）。

**帧格式**

```jsonc
// 应用端 → 适配器（动作调用）
{ "action": "send_group_msg", "params": { "group_id": 10000000000001, "message": "hello" }, "echo": "req-1" }

// 适配器 → 应用端（动作回包）
{ "status": "ok", "retcode": 0, "data": { "message_id": 10000000000077, "passive": true }, "message": "", "echo": "req-1" }
```

- `status`：`ok` / `failed` / `async`
- `retcode`：`0` 成功、`1400` 请求非法（缺参数/目标未知/窗口关闭）、`1404` 动作不支持（官方平台无对应能力）
- 事件帧与 OneBot v11 标准一致（`post_type` 等字段）。

**事件流**：连接建立时收到 `meta_event/lifecycle`；之后每 30 秒 `meta_event/heartbeat`；业务事件按其 `post_type` 推送。

---

## 2. 使用前提

1. `NOA_APP_ID` / `NOA_APP_SECRET` 环境变量已设置，`npm start` 已连上官方网关。
2. **发送目标必须“见过”**：
   - 群：机器人已被拉进群（`GROUP_ADD_ROBOT`）、群里有人 @ 过机器人，或全量模式下收到过该群任意消息 → 该群才有伪号与目录记录；
   - 私聊：该用户必须先私聊过机器人 → 该用户才有伪号。
   - 否则 `send_group_msg` / `send_private_msg` 返回 `1400 未知 group_id / user_id`。
3. **ID 口径**：默认 `idMode: "mapped"`，事件里的 `group_id` / `user_id` / `message_id` 是伪 QQ 号（从 10^13 起），直接用事件里拿到的数字回传即可；`passthrough` 模式则原样透传 openid 字符串。
4. **被动窗口**：群 5 分钟内最多 5 条、单聊 60 分钟内最多 4 条（按触发消息计）。无可用窗口时由 `passiveOverflow` 决定：`fail`（默认，返回 1400）或 `proactive`（转主动消息，受本地配额限制）。
5. **平台权限与群主开关**：禁言、入群审批等需要在 QQ 开放平台开通对应权限；**全量群消息不是开放平台权限**，而是群主在手机 QQ 群设置里开启「获取群内全部消息」（见 §6.3）。主动消息还受群内「机器人主动在群聊内发言」开关和平台配额限制（`40034105` 无权限、`40034100` 超频）。

---

## 3. 动作总览

### 3.1 可用（9 个）

| 动作 | 说明 | 限制 |
|---|---|---|
| `send_msg` | 按 `message_type` 或 `group_id`/`user_id` 分派 | 仅纯文本 |
| `send_group_msg` | 发群消息 | 仅纯文本；群必须已“见过” |
| `send_private_msg` | 发单聊消息 | 仅纯文本；用户必须先私聊过机器人 |
| `get_login_info` | 机器人自身信息 | `nickname` 固定为 `Arona` |
| `get_version_info` | 适配器版本 | `protocol_version` = `v11` |
| `get_group_info` | 群基本信息 | 来自本地群目录；`member_count` 恒为 0 |
| `get_group_list` | 已知群列表 | 仅“见过”的群，非平台全量 |
| `set_group_add_request` | 入群申请审批 | 需官方群管理权限 |
| `set_group_ban` | 群禁言 | 需官方权限；成员级接口未真机验证；省略 `user_id` 为全群路径（两种模式），`user_id=0` 仅 `mapped` 模式 |

### 3.2 受限 / 占位（8 个）

| 动作 | 现状 | 说明 |
|---|---|---|
| `get_status` | ⚠️ **占位** | 当前恒返回 `{online:true, good:true}`，**不能判断真实网关在线状态**；不要依赖它做健康检查 |
| `delete_msg` | ⚠️ **当前实际不可用** | 消息缓存只记录入站消息，机器人自己发出的消息未入缓存；而官方只允许撤回机器人自己 2 分钟内的消息 → 撤回自家回复会返回“消息不在本地缓存中”。修复计划：发送成功后写入缓存。 |
| `get_msg` | 部分可用 | 仅能查本地缓存中的**入站**消息（容量 2000 条、保留 15 分钟） |
| `get_group_member_info` | 仅机器人自身 | 查询其他成员返回 `1404`（官方无成员信息 API） |
| `can_send_image` | 占位 | 返回 `{yes:true}`，但富媒体发送一期未开放，实际发送会 `1400` |
| `can_send_record` | 占位 | 同上 |
| `set_restart` | 占位 | 返回 `status:"async"`，**不会实际重启进程** |
| `clean_cache` | 占位 | 返回成功，**不执行实际清理** |

### 3.3 明确拒绝（21 个，统一 `retcode=1404`）

| 动作 | 原因 |
|---|---|
| `get_friend_list` | 官方平台无好友列表 API |
| `get_stranger_info` | 官方平台无陌生人信息 API |
| `get_group_member_list` | 官方平台无群成员列表 API |
| `set_group_kick` | 官方群机器人无踢人 API |
| `set_group_admin` | 官方群机器人无管理员任免 API |
| `set_group_card` | 官方群机器人无群名片 API |
| `set_group_special_title` | 官方群机器人无专属头衔 API |
| `set_group_anonymous` | 官方群机器人无匿名消息能力 |
| `set_group_anonymous_ban` | 官方群机器人无匿名成员禁言 API |
| `set_group_leave` | 官方群机器人无主动退群 API |
| `set_group_whole_ban` | 官方全员禁言未对齐，一期统一拒绝 |
| `set_group_name` | 官方群机器人无改群名 API |
| `send_like` | 官方平台无名片点赞 API |
| `get_group_honor_info` | 官方平台无群荣誉 API |
| `get_cookies` / `get_csrf_token` / `get_credentials` | 官方开放平台无 Cookie/CSRF 体系 |
| `get_forward_msg` | 官方平台无合并转发消息获取 API |
| `get_image` / `get_record` | 本地媒体缓存代理二期实现 |
| `set_friend_add_request` | 平台未向群/单聊机器人开放好友审批 |

> 未出现在上表的动作名同样返回 `1404`（动作不存在）。`retcode=1404` 的 `message` 会写明具体原因，旧程序可据此优雅降级。

---

## 4. 可用动作详解

### 4.1 发送消息：`send_group_msg` / `send_private_msg` / `send_msg`

**参数**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string / array / object | 是 | 字符串按 CQ 码解析；数组为 OneBot 段数组 |
| `group_id` | number/string | 群消息必填 | 伪群号（事件里拿到的值） |
| `user_id` | number/string | 私聊必填 | 伪 QQ 号 |
| `message_type` | `group`/`private` | 否 | `send_msg` 用它分派；省略时按 group_id/user_id 推断 |

**回包 `data`**：`{ "message_id": <伪消息号>, "passive": true|false }`

**只支持纯文本。** 以下情况返回 `1400`：
- 含 `image` / `record` / `video` 段 → “富媒体发送（图片/语音/视频）暂未开放：需要先上传获取官方 file_info（二期）”；
- 含 `json` / `xml` / `music` / `share` / `contact` / `location` / `rps` / `dice` / `poke` / `shake` / `anonymous` / `forward` / `node` 等官方无对应能力的段；
- 文本为空；
- 目标不在映射中（`未知 group_id/user_id`）；
- 无被动窗口且 `passiveOverflow: "fail"`。

**示例**

```jsonc
{
  "action": "send_group_msg",
  "params": { "group_id": 10000000000001, "message": "收到，正在处理" },
  "echo": "1"
}
```

被动窗口由适配器自动处理：对触发本次对话的用户消息，第 1~5 条回复自动带 `msg_id + msg_seq`；私聊为第 1~4 条。

### 4.2 `get_login_info`

```jsonc
{ "action": "get_login_info", "params": {}, "echo": "2" }
// data: { "user_id": 10000000000000, "nickname": "Arona" }
```

`user_id` 是由机器人 openid（或 AppID）派生的稳定伪号，与事件里的 `self_id` 一致。

### 4.3 `get_status`

```jsonc
// 当前实现固定返回：{ "online": true, "good": true }
```

⚠️ **占位实现**：适配器内部的发送器在启动后常驻，`get_status` 不会反映官方网关的真实断线状态，恒为 `true`。不要用它判断机器人是否在线；真实连接状态请以进程日志为准。代码修复（接入网关在线状态）列入后续计划。

### 4.4 `get_version_info`

```jsonc
// data: { "app_name": "noa-ark", "app_version": "0.1.0", "protocol_version": "v11", "id_mode": "mapped" }
```

### 4.5 `get_group_info` / `get_group_list`

```jsonc
// get_group_info
{ "action": "get_group_info", "params": { "group_id": 10000000000001 } }
// data: { "group_id": 10000000000001, "group_name": "测试群", "member_count": 0, "max_member_count": 0 }
```

- 数据来自本地群目录（入群事件 + 收到过消息的群），**不是平台全量列表**。
- 群名只有在平台事件中带 `group_name` 时才有；否则为空（一期没有手动别名功能）。
- `member_count` 恒为 0（官方不提供）。

### 4.6 `set_group_add_request`

```jsonc
{ "action": "set_group_add_request", "params": { "flag": "GROUP_OPENID:42", "approve": true } }
```

- `flag` **必须原样回传** `request.group` 事件里的 `flag`（内部编码了群 openid 与请求序列号）。
- `approve` 默认 `true`；`reason`、`sub_type` 当前忽略。
- 需要官方群管理权限；失败时回包 `1400` 并带平台错误信息。

### 4.7 `set_group_ban`

```jsonc
{ "action": "set_group_ban", "params": { "group_id": 10000000000001, "user_id": 10000000000002, "duration": 600 } }
```

- `duration` 单位秒，`0` 表示取消；默认 1800。
- `user_id` 省略 → 走全群禁言路径（两种模式都可用）；`user_id=0` 仅 `mapped` 模式下视为全群（`passthrough` 会把 `"0"` 当作 openid，请直接省略 `user_id`）；指定成员时该 `user_id` 必须已在本地映射中（该成员发过言），否则 `1400`。
- 注意与 `set_group_whole_ban` 的区别：后者是 OneBot 标准动作，本适配器**未实现**（统一 `1404`）；全群禁言只能通过本动作的“省略 user_id”路径尽力调用官方接口。
- 依赖官方禁言接口与权限，**成员级路径未真机验证**。

---

## 5. 受限/占位动作详解

### 5.1 `delete_msg`（当前实际不可用）

```jsonc
{ "action": "delete_msg", "params": { "message_id": 10000000000077 } }
```

适配器只把**入站**消息写入缓存；机器人自己发出的消息没有写入缓存。官方只允许撤回机器人自己 2 分钟内的消息，因此：

- 撤回入站消息（别人的）→ 平台会拒绝；
- 撤回刚发出的回复 → 本地缓存查不到，返回 `1400 消息不在本地缓存中`。

修复计划：发送成功后把官方返回的 `message_id` 写入缓存（二期/补丁）。

### 5.2 `get_msg`

```jsonc
{ "action": "get_msg", "params": { "message_id": 10000000000099 } }
```

仅能返回本地缓存中的**入站**消息（最多 2000 条、保留 15 分钟）；返回 `time` / `message_type` / `sender` / `message` / `raw_message`。缓存外的消息返回 `1400`。

### 5.3 `get_group_member_info`

仅支持查询机器人自身（`user_id` 等于 `self_id`）；查询其他成员返回 `1404`。

### 5.4 `can_send_image` / `can_send_record`

返回 `{ "yes": true }`，表示官方平台具备富媒体能力；但**一期发送富媒体会明确失败**，请勿据此认为可以直接发图/语音。

### 5.5 `set_restart` / `clean_cache`

- `set_restart` 返回 `{ "status": "async", "retcode": 1 }`，不执行重启。
- `clean_cache` 返回成功，不做实际清理。

---

## 6. 事件

### 6.1 会收到的事件

| 事件 | 触发 | 备注 |
|---|---|---|
| `message` + `message_type=group` | 群内 @ 机器人（`GROUP_AT_MESSAGE_CREATE`）；或群主开启全量模式后的任意群消息（`GROUP_MESSAGE_CREATE`） | `message` 为段数组、`raw_message` 为 CQ 串；额外带 `at_me` / `to_me`（见 §6.3） |
| `message` + `message_type=private`, `sub_type=friend` | 用户私聊机器人 | `at_me=false`、`to_me=true` |
| `notice` `group_increase` | 机器人入群（`GROUP_ADD_ROBOT`）；成员入群需 intents `1<<24` | 机器人入群时 `user_id=self_id` |
| `notice` `group_decrease` | 机器人被移出（`GROUP_DEL_ROBOT`）；成员退群需 intents `1<<24` | 机器人被移出为 `sub_type=kick_me`，成员退群为 `leave` |
| `notice` `friend_add` | 好友添加完成 | 需平台权限 |
| `request` `group` `sub_type=add` | 入群申请 | `flag` 供审批使用 |
| `request` `friend` | 好友验证 | 需平台权限 |
| `meta_event` `lifecycle` / `heartbeat` | 连接/每 30 秒 | — |

### 6.2 收不到的事件

- **撤回通知**（`group_recall` / `friend_recall`）：官方平台不推送撤回事件；
- `group_ban`、`group_upload`、`group_admin`、戳一戳、`input_notify`、频道（guild）事件：一期未映射；
- `GROUP_MEMBER_ADD` / `GROUP_MEMBER_QUIT`：映射已实现，但官方网关默认只申请 `1<<25` intents，成员事件需要 `1<<24`，当前没有 intents 配置项 → **默认收不到**（待二期加配置）。

> 「群里未被 @ 的消息」不属于收不到的事件：群主开启全量模式后即会以 `GROUP_MESSAGE_CREATE` 下发，见 §6.3。

### 6.3 群聊全量消息（接收所有消息）

官方有两套群消息事件，共用 Intent `1<<25`（`GROUP_AND_C2C_EVENT`），本适配器默认已订阅，无需改配置：

- `GROUP_AT_MESSAGE_CREATE`：仅 @ 机器人时下发；官方 content 已去掉 @ 前缀。
- `GROUP_MESSAGE_CREATE`：群主开启「接收所有消息」后，群内每条消息（含未 @）都会下发。

**开启方式（群主操作，不是开放平台权限申请）**

1. 群主用手机 QQ（iOS / Android；PC 端目前没有该设置入口）打开目标群 → 群设置 → 机器人 → 机器人设置。
2. 把「机器人可获取的群聊消息范围」设为「获取群内全部消息」（默认是「仅 @ 机器人」）。
3. 如需机器人超被动窗口主动发言，同时开启「机器人主动在群聊内发言」；它与消息范围是两个独立开关。
4. 适配器无需重启；群设置生效后下一条群消息即可收到 `GROUP_MESSAGE_CREATE`。

**@ 判定**

- 官方新格式在 content 中用 `<@member_openid>` / `<@all>` 标记；旧格式为 `<qqbot-at-user id="..."/>` / `<qqbot-at-everyone/>`。两种都会还原为 OneBot `at` 段（`all` → `[CQ:at,qq=all]`）。
- `GROUP_AT_MESSAGE_CREATE` 的 content 被平台去掉了 @ 前缀，适配器会补回 `[CQ:at,qq=<self_id>]`，让按 at 段判断「是否叫我」的旧程序行为保持一致。
- 群消息事件额外带两个 noa 扩展字段：`at_me`（是否 @ 机器人）与 `to_me`（是否发给机器人；私聊恒为 `true`）。
- `at_me` 的判定来源（任一成立）：事件类型为 `GROUP_AT_MESSAGE_CREATE`、content 里有指向机器人的 @ 标记、`mentions` 里 `is_you=true` 或 `id` / `user_openid` / `member_openid` 等于机器人 openid。
- 全量模式下未 @ 机器人的消息 `at_me=false`、`to_me=false`；是否响应由旧程序自行决定。

### 6.4 重复投递与并发触发

官方未承诺 `GROUP_AT_MESSAGE_CREATE` 与 `GROUP_MESSAGE_CREATE` 互斥，且网关重连/平台重试时同一 `msg_id` 可能重复推送。适配器按官方原始 `msg_id` 做 5 分钟去重（容量 2000，first-wins）：

- 同一 `msg_id` 在窗口内只向下游投递一次；
- 两个事件名携带同一 `msg_id` 时也只投递首次到达的版本；
- 被动回复窗口同样按原始 `msg_id` 记账，重复投递不会重置窗口或额外消耗配额；
- 重复推送不会续期：TTL 从首次到达起算，持续重复推送不会延长去重窗口；
- 空 `msg_id` 不参与去重；
- 容量 2000：短时间内超过 2000 条不同消息时，最早插入的 id 会提前失效；
- 超过 5 分钟再次到达视为新消息（msg_id 本身全局唯一，过期只为释放内存）。

如果旧程序还需要按内容做幂等/防抖，可以自行叠加，不会与适配器冲突。

### 6.5 富媒体与消息元素降级

- **图片 / 视频 / 语音**：`attachments` → `image` / `video` / `record` 段。语音优先使用 `voice_wav_url`，`summary` 带 ASR 参考文本；未知附件降级为 `[附件:文件名]`。
- **`message_type=101/102/103`**（并行消息 / 聊天记录 / 引用消息）：官方正文放在 `msg_elements` 里，`content` 可能只是空白。适配器会展开元素的 `content`、附件和嵌套元素（深度上限 4）为普通段。
- **`message_type=3` / `ark_data`**（小程序、图文、名片、位置等卡片）：降级为 `[卡片:标题]` 文本，消息不丢失，但无法还原卡片交互。
- **引用关系**：官方只给 `message_scene.ext.ref_msg_idx`，没有对应可查询的 `msg_id`，因此不生成 `reply` 段。
- 一期只支持纯文本发送；以上是接收侧降级，不代表可以把这些段原样发回去。

---

## 7. 错误码与排查

| 现象 | 原因与处理 |
|---|---|
| `401` / WS 握手失败 | token 不匹配；检查 `onebot.accessToken` 与请求头/query |
| 普通 HTTP 返回 `426` | 预期行为：本适配器没有 HTTP API，请走 WS |
| `retcode=1400 未知 group_id` | 群尚未“见过”（机器人未入群/无人 @ 过）；先让机器人收到该群消息 |
| `retcode=1400 未知 user_id` | 用户尚未私聊过机器人 |
| `retcode=1400 被动回复窗口已关闭` | 群 5 分钟/5 条或单聊 60 分钟/4 条用尽；改用 `passiveOverflow: "proactive"` 或等待 |
| `retcode=1400` 且 message 含“富媒体发送” | 一期只支持纯文本，图片/语音/视频未开放 |
| `retcode=1404 …` | 官方平台无该能力，按 `message` 降级处理 |
| 平台错误码 `40034105` | 机器人没有主动消息权限；群聊还需群主开启「机器人主动在群聊内发言」 |
| 平台错误码 `40034100` | 主动消息超频；降低频率或等待 |
| 发送成功但撤回失败 | `delete_msg` 当前缺陷，见 §5.1 |
| 收不到群里未 @ 的消息 | 群主未开启「获取群内全部消息」；按 §6.3 操作（PC 端 QQ 没有该设置入口） |
| 同一条消息收到两次 | 适配器按 `msg_id` 去重 5 分钟；超过窗口或旧程序自身重复处理时会再次出现，可在程序侧加幂等 |
| 消息里出现 `<@xxx>` 或 `[卡片:…]` | 新版 @ 标记已还原为 at 段；卡片按 §6.5 降级为文本，不是解析错误 |

---

## 8. 最小接入示例

`~/.noa/config.json`：

```json
{
  "idMode": "mapped",
  "passiveOverflow": "fail",
  "onebot": {
    "enable": true,
    "accessToken": "change-me",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": ["ws://127.0.0.1:6700"]
  }
}
```

启动：

```bash
set NOA_APP_ID=你的AppID
set NOA_APP_SECRET=你的AppSecret
npm start
```

旧程序作为 WS 服务端监听 `127.0.0.1:6700`；本适配器按 `reverseUrls` 主动拨号连接，连上后推送事件、接收动作。若用正向 WS，则改为旧程序连接 `ws://127.0.0.1:7791/ws?access_token=change-me`。

---

## 9. 已知限制（一期）

1. 仅纯文本发送；富媒体、markdown/keyboard、卡片、合并转发未开放。
2. `delete_msg` 撤回自家消息未接通（见 §5.1）。
3. 成员进出事件默认收不到（intents 未配置 `1<<24`）。
4. 无 WebUI、配置热更新、文件日志；群目录不能手动加群/设别名。
5. 官方 REST 路径（禁言/审批/媒体）与 token 端点尚未真机验证。
6. 正向 WS 只支持单一路径，不支持 `/api` + `/event` 分离模式。
7. 接收侧 101/102/103 元素与卡片只做文本/附件降级，不生成 `reply` 段；C2C 事件的 `msg_elements`/`ark_data` 尚未展开（主要出现在全量群消息）。
8. 全量群消息依赖群主在手机 QQ 手动开启；PC 端 QQ 暂无该入口。

更完整的协议映射与下期计划见 [文档.md](文档.md)。
