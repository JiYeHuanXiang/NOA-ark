# NOA-onebot 使用手册（动作与能力）

> 对应实现：`src/onebot/actions.ts`（动作）、`src/onebot/events.ts`（事件）、`src/noa/*`（noa/1 扩展）、`src/onebot/server.ts` / `reverse.ts`（通信）。
> 版本：0.1.9。
> 本手册描述**当前实现**（快照时间：2026-11-15）；`noa_*` 扩展已实现但默认关闭，见 §5.7。

---

## 1. 连接方式

NOA-onebot **只提供 WebSocket**（HTTP API 与 HTTP POST 上报已移除）。所有动作与事件共用同一条连接。

| 方式 | 说明 |
|---|---|
| 反向 WS（推荐） | 适配器主动连接旧程序，配置 `onebot.reverseUrls[]`（如 `ws://127.0.0.1:6700`）。`onebot.mode` 为 `forward` 时不连接。 |
| 正向 WS | 旧程序连接 `ws://127.0.0.1:7791/ws`（端口/路径由 `onebot.wsPort` / `onebot.wsPath` 决定）。`onebot.mode` 为 `reverse` 时不监听。 |
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

OneBot v11 标准动作共 38 个：19 个可用、3 个受限/占位、16 个明确拒绝；另有 `noa/1` 扩展动作 29 个（默认关闭，见 §5.7）。

### 3.1 可用（19 个）

| 动作 | 说明 | 限制 |
|---|---|---|
| `send_msg` | 按 `message_type` 或 `group_id`/`user_id` 分派 | 文本 + 图片/语音/视频 |
| `send_group_msg` | 发群消息 | 文本 + 富媒体；群必须已“见过” |
| `send_private_msg` | 发单聊消息 | 文本 + 富媒体；用户必须先私聊过机器人 |
| `get_login_info` | 机器人自身信息 | `nickname` 取官方 `username`，获取失败回退 `noa-ark` |
| `get_status` | 网关真实在线状态 | `online` / `good` 来自官方 WSS READY/RESUMED，断线为 `false` |
| `get_version_info` | 适配器版本 + noa/1 能力 | `protocol_version=v11`、`noa_ext_version=noa/1`、`noa_ext[]` |
| `get_group_info` | 群基本信息 | 官方群信息优先（需白名单），失败回退本地目录；`source` 标明来源 |
| `get_group_list` | 已知群列表 | 仅“见过”的群，非平台全量；`member_count` 恒为 0 |
| `get_group_member_list` | 群成员列表 | 官方 2026-09-03 白名单接口（`11253` 无权限）；30 条/页，最多 20 页 |
| `get_group_member_info` | 单个群成员 | 官方白名单接口；机器人自身直接返回 |
| `set_group_kick` | 移除群成员 | 官方批量移除（白名单）；`reject_add_request=true` 同时拉黑 |
| `set_group_add_request` | 入群申请审批 | 需官方群管理权限 |
| `set_group_ban` | 群禁言 | 需官方权限；`user_id` 必填（成员级未真机验证）；`user_id=0` 仅在 `mapped` 模式等价全员禁言；全员禁言请用 `set_group_whole_ban` |
| `set_group_whole_ban` | 全员禁言 | 需官方权限；`enable=true` 固定 24 小时，`false` 解除 |
| `delete_msg` | 撤回机器人自己发出的消息 | 仅 2 分钟内；消息必须由本进程发送（已自动写入缓存） |
| `get_image` | 图片附件缓存 | 传附件 URL → 本地路径（单文件 ≤20MB） |
| `get_record` | 语音附件缓存 | 同上 |
| `can_send_image` | 固定 `{yes:true}` | 富媒体发送已接线 |
| `can_send_record` | 固定 `{yes:true}` | 同上 |

### 3.2 受限 / 占位（3 个）

| 动作 | 现状 | 说明 |
|---|---|---|
| `get_msg` | 部分可用 | 本地缓存反查（容量 2000 条、保留 15 分钟），包含**入站消息**与本适配器**出站消息** |
| `set_restart` | 占位 | 返回 `status:"async"`，**不会实际重启进程** |
| `clean_cache` | 占位 | 返回成功，**不执行实际清理** |

### 3.3 明确拒绝（16 个，统一 `retcode=1404`）

| 动作 | 原因 |
|---|---|
| `get_friend_list` | 官方平台无好友列表 API |
| `get_stranger_info` | 官方平台无陌生人信息 API |
| `set_group_admin` | 官方群机器人无管理员任免 API |
| `set_group_card` | 官方群机器人无群名片 API |
| `set_group_special_title` | 官方群机器人无专属头衔 API |
| `set_group_anonymous` | 官方群机器人无匿名消息能力 |
| `set_group_anonymous_ban` | 官方群机器人无匿名成员禁言 API |
| `set_group_leave` | 官方群机器人无主动退群 API |
| `set_group_name` | 官方群机器人无改群名 API |
| `send_like` | 官方平台无名片点赞 API |
| `get_group_honor_info` | 官方平台无群荣誉 API |
| `get_cookies` / `get_csrf_token` / `get_credentials` | 官方开放平台无 Cookie/CSRF 体系 |
| `get_forward_msg` | 官方平台无合并转发消息获取 API |
| `set_friend_add_request` | 平台未向群/单聊机器人开放好友审批 |

> 未出现在上表的动作名同样返回 `1404`（动作不存在）。`retcode=1404` 的 `message` 会写明具体原因，旧程序可据此优雅降级。
> 发送含 `face` 段、群聊 `@具体成员`（标准文本通道）或单聊任意 `at` 属于消息内容非法，返回 `1400`（不是 `1404`），见 §4.1。
> 群成员列表/详情/批量移除接口仅白名单机器人可用；无权限时返回 `1400` 并带平台错误码 `11253`。
> `noa_*` 扩展动作未启用时也返回 `1404`，见 §5.7。

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
| `event_id` | string | 否 | 被动回复事件 id（与被动 `msg_id` 二选一）；官方按群聊/单聊限制可回传的事件类型 |

**回包 `data`**：

```jsonc
{
  "message_id": 10000000000077,     // 第一条消息的伪号
  "message_ids": [10000000000077],  // 本次发送的全部分片
  "passive": true,
  "quoted": true,                   // 是否成功带上引用气泡
  "warning": "…"                    // 仅在引用退化时出现
}
```

**支持的内容**

| 段 | 发送行为 |
|---|---|
| `text` | `msg_type=0` |
| `at(qq=all)` | 群聊：拼进文本 `<qqbot-at-everyone />`（机器人需为群管理员；每群每天仅 1 次）；单聊：`1400` |
| `at(qq=用户)` | 群聊：仅当同一消息含 `noa_markdown` 时转换为 `<qqbot-at-user id="openid" />`；标准文本通道返回 `1400`；单聊不支持 @ |
| `reply` | 取消息缓存中的官方 `REFIDX` 填 `message_reference`；取不到时正文照发，`quoted=false` + `warning` |
| `image` / `record` / `video` | 先上传得 `file_info`，再 `msg_type=7`；`file`/`url` 支持公网 URL、`base64://`、本地路径/`file://`（≤5MB 直传，>5MB 自动分片） |
| `noa_markdown` | `msg_type=2`；需 `noa.ext.markdown=true`；不能与 text/富媒体/卡片混排 |
| `noa_keyboard` | 挂在 text / `noa_markdown` 上（官方 keyboard 字段）；需 `noa.ext.keyboard=true` |
| `noa_card` | `msg_type=8` 图文卡片；需 `noa.ext.card=true`；必须单独发送 |

**混排**：文本与富媒体会按原顺序拆成多条官方消息，每条各消耗一次被动槽。例如 `[text, image]` → 一条文本 + 一条图片，`message_ids` 返回两个号。

> 多分片发送中途失败时，已发送的分片不会回滚，也不会出现在失败回包里；重试前请自行去重（按文本内容或本地记录）。

**富媒体限制**

- 本地 / base64 文件 ≤5MB 走二进制直传，>5MB 自动走分片上传；官方硬上限 200MB。
- 每次发送都会重新上传（`file_info` 有 TTL，官方群/单聊上传结果不互通）。
- 图片格式以平台要求为准（png/jpg 等）；语音建议 silk/mp3/wav。

**以下情况返回 `1400`**：

- 含 `face` 段 → 官方系统表情 `<emoji:id>` 仅文字子频道可用；
- 群聊 `@具体成员`（`at(qq=<用户>)`）→ 官方只支持 markdown 消息，标准文本通道做不出真 @；
- 单聊任意 `at` → 官方单聊不支持 @；
- 含 `json` / `xml` / `music` / `share` / `contact` / `location` / `rps` / `dice` / `poke` / `shake` / `anonymous` / `forward` / `node` 等官方无对应能力的段；
- 含 `noa_markdown` / `noa_keyboard` / `noa_card` 且对应 `noa.ext.*` 未启用；启用后按扩展段的组合规则校验（如 keyboard 单独出现、markdown 与 text 混排都会 `1400`）；
- 文本为空（纯空白也算空）；
- 目标不在映射中（`未知 group_id/user_id`）；
- 无被动窗口且 `passiveOverflow: "fail"`；
- 富媒体上传/发送被平台拒绝（`message` 带平台错误码）。

> `noa_ark` / `noa_embed` 在群/单聊无法发送，即使启用 noa/1 也返回 `1404`；图文卡片请用 `noa_card`。

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
// data: { "user_id": 10000000000000, "nickname": "你的机器人昵称" }
```

`user_id` 是由机器人 openid（或 AppID）派生的稳定伪号，与事件里的 `self_id` 一致。
`nickname` 在启动时取官方 `/users/@me` 的 `username`；接口失败或未返回时回退 `noa-ark`。

### 4.3 `get_status`

```jsonc
// data: { "online": true, "good": true }
```

`online` / `good` 读取官方 WSS 网关真实状态：收到 `READY` 或 `RESUMED` 后为 `true`，连接断开立即为 `false`。可用于健康检查；网关重连期间可能短暂为 `false`。

### 4.4 `get_version_info`

```jsonc
// data: {
//   "app_name": "noa-ark", "app_version": "0.1.9", "protocol_version": "v11",
//   "id_mode": "mapped",
//   "noa_ext_version": "noa/1",
//   "noa_ext": ["markdown", "keyboard"]
// }
```

`noa_ext` 只列出当前配置启用的能力（关键字与 `noa.ext.*` 同名）；全部关闭时为空数组。

### 4.5 `get_group_info` / `get_group_list`

```jsonc
// get_group_info
{ "action": "get_group_info", "params": { "group_id": 10000000000001 } }
// data: { "group_id": 10000000000001, "group_name": "测试群", "member_count": 256, "max_member_count": 0, "source": "official" }
```

- 先调官方 `GET /v2/groups/{group_openid}/info`（需平台白名单权限，30 QPM）；成功时 `source="official"`，`member_count` 取 `group_member_num`。
- 官方接口无权限/失败时回退本地群目录（入群事件 + 收到过消息的群），`source="registry"`，`member_count=0`。
- `get_group_list` 仍只来自本地目录，**不是平台全量列表**；为避免触发 30 QPM 限制，不会逐群调用官方接口。

### 4.6 `set_group_add_request`

```jsonc
{ "action": "set_group_add_request", "params": { "flag": "GROUP_OPENID:42", "approve": true } }
```

- `flag` **必须原样回传** `request.group` 事件里的 `flag`：新事件为 `group_openid:member_openid:join_request_id`（三段），旧事件为 `group_openid:event_seq`（两段）。
- `approve` 默认 `true`；`approve=false` 时 `reason` 作为 `reject_reason` 透传给新审批端点；`sub_type` 当前忽略。
- 三段 `flag` 走新端点 `approval_join_request`，两段 `flag` 走旧端点兼容历史事件；若事件带 `join_request_id` 但缺少申请人 openid，或连事件序号也没有，视为缺少必要信息：事件 `flag` 为空，`set_group_add_request` 本地直接 `1400`。
- 需要官方群管理权限，失败时回包 `1400` 并带平台错误信息。

### 4.7 `set_group_ban`

```jsonc
{ "action": "set_group_ban", "params": { "group_id": 10000000000001, "user_id": 10000000000002, "duration": 600 } }
```

- `duration` 单位秒，`0` 表示取消；默认 1800。
- `user_id` **必填**；省略或空值返回 `1400`，并提示改用 `set_group_whole_ban`。
- 指定成员时该 `user_id` 必须已在本地映射中（该成员发过言，或在成员列表/成员详情里出现过），否则 `1400`。
- `user_id=0` 仅在 `mapped` 模式下视为全员禁言路径；`passthrough` 会把 `"0"` 当作 openid，请改用 `set_group_whole_ban`。
- 全员禁言请使用标准动作 `set_group_whole_ban`（见 §4.8）。
- 依赖官方禁言接口与权限，**成员级路径未真机验证**。

### 4.8 `set_group_whole_ban`

```jsonc
// 开启全员禁言
{ "action": "set_group_whole_ban", "params": { "group_id": 10000000000001, "enable": true } }
// 解除
{ "action": "set_group_whole_ban", "params": { "group_id": 10000000000001, "enable": false } }
```

- OneBot 标准只有 `enable`，没有 `duration`：`true` 固定 24 小时，`false` 为 0 秒解除。
- 走官方禁言接口的全群路径（不带 `member_openid`）；需要官方权限。
- 回包 `data` 为 `null`。

---

## 5. 其他动作详解

### 5.1 `delete_msg`

```jsonc
{ "action": "delete_msg", "params": { "message_id": 10000000000077 } }
```

适配器在发送成功后会把自己发出的消息写入消息缓存，因此可以撤回**本进程发出的、2 分钟内**的消息：

- 撤回本进程刚发出的回复 → 正常撤回；
- 撤回入站消息（别人的）→ 平台只允许撤回机器人自己的消息，返回 `1400` 并带平台错误；
- 撤回缓存外/超过 2 分钟的消息 → 本地 `1400 消息不在本地缓存中` 或平台拒绝；
- 进程重启后旧消息仍在映射中但不在本次缓存，可能找不到记录。

### 5.2 `get_msg`

```jsonc
{ "action": "get_msg", "params": { "message_id": 10000000000099 } }
```

返回本地缓存中的消息（最多 2000 条、保留 15 分钟），包含**入站消息**与本适配器**出站消息**；返回 `time` / `message_type` / `sender` / `message` / `raw_message`。缓存外的消息返回 `1400`。

### 5.3 群成员：`get_group_member_list` / `get_group_member_info` / `set_group_kick`

官方面向白名单机器人开放（2026-09-03）。无权限时返回 `1400`，`message` 带平台错误码 `11253`。

```jsonc
// 列表（30 条/页，适配器自动翻页，最多 20 页）
{ "action": "get_group_member_list", "params": { "group_id": 10000000000001 } }
// data: [{ group_id, user_id, nickname, card: "", role: "member|admin|owner", join_time, last_sent_time: 0, is_robot }]

{ "action": "get_group_member_info", "params": { "group_id": 10000000000001, "user_id": 10000000000002 } }
// data: { group_id, user_id, nickname, card: "", role, level: 0, title: "", join_time, is_robot }

// 移除并同时加入群黑名单
{ "action": "set_group_kick", "params": { "group_id": 10000000000001, "user_id": 10000000000002, "reject_add_request": true } }
```

- `user_id` 必须是本地映射中已知的 openid（该成员发过言、或在成员列表里出现过）；否则 `1400`。
- `set_group_kick` 底层是官方批量移除接口（单次 ≤20），本动作一次移除 1 人；`reject_add_request=true` 映射为「同时加入群黑名单」，拉黑失败时回包 `data.blacklist_failed=true`，移除本身仍算成功。
- 机器人自身信息不走官方接口，直接返回 `noa-ark` / `self_id`。
- 列表超过 20 页（600 人）会截断并在日志告警。

### 5.4 `get_image` / `get_record`

```jsonc
{ "action": "get_image", "params": { "file": "https://multimedia.nt.qq.com.cn/xxx" } }
// data: { "file": "C:\\...\\data\\cache\\media\\<sha256>.png", "url": "https://...", "size": 12345, "cached": false }
```

- 入站图片/语音段的 `file` 就是官方附件 URL，把它传进来即可。
- 适配器下载到 `data/cache/media/`（单文件 ≤20MB、20 秒超时），按 URL 哈希命名；同一 URL 再次调用直接命中本地文件（`cached=true`）。
- 非 http/https URL、本机/内网字面量地址、重定向跳入内网、超过上限或下载失败 → `1400`。只做缓存代理，不修改附件内容；不做 DNS 解析后的 IP 固定（域名解析到内网的情况不拦截）。

### 5.5 `can_send_image` / `can_send_record`

返回 `{ "yes": true }`，且富媒体发送已接线（`msg_type=7`）：图片/语音/视频可发，支持公网 URL、≤5MB 本地/`base64://` 直传，更大文件自动分片上传。详见 §4.1。

### 5.6 `set_restart` / `clean_cache`

- `set_restart` 返回 `{ "status": "async", "retcode": 1 }`，不执行重启。
- `clean_cache` 返回成功，不做实际清理。

### 5.7 noa/1 扩展动作（默认关闭）

共 29 个动作：扩展动作 28 个 + dsh 专属 1 个。需在配置 `noa.ext.*` 显式启用；未启用时统一 `1404`。

| 动作 | 开关 | 场景 | 说明 |
|---|---|---|---|
| `noa_send_typing` | `typing` | 单聊 | 「正在输入」1–60 秒（默认 8）；占一次被动槽 |
| `noa_ack_interaction` | `interaction` | 全部 | 回应 `INTERACTION_CREATE`；`code` 0–5 |
| `noa_set_menu` | `menu` | 单聊 | `menu` 对象原样透传，返回 `version` |
| `noa_set_panel` / `noa_list_panels` | `menu` | 群/单聊 | `panel` 为官方 `POST /v2/panels` 请求体；列表需必填 `scope`（`c2c` / `group`），可选 `cursor` / `limit` |
| `noa_set_group_add_request_policy` | `joinPolicy` | 群 | 启用/关闭自动审批、改白名单、`execute` 全量扫描 |
| `noa_stream_begin` / `noa_stream_append` / `noa_stream_end` | `stream` | 单聊 | 流式消息；首帧返回 `stream_id`，后续帧传 `stream_id` |
| `noa_send_wakeup` | `wakeup` | 单聊 | 互动召回（`is_wakeup=true`） |

管理、素材与分享（18 个，同样默认关闭）：

| 动作 | 开关 | 场景 | 说明 |
|---|---|---|---|
| `noa_get_menu` | `menu` | 单聊 | 查询全局自定义菜单，返回 `{version, menu}` |
| `noa_get_panel` / `noa_update_panel` / `noa_delete_panel` | `menu` | 群/单聊 | 面板详情 / 覆盖更新 / 删除；`panel_id` 必填 |
| `noa_set_panel_target` | `menu` | 群/单聊 | 增删面板关联对象：`op`=`add`/`del`，`user_openids`/`user_ids` 或 `group_openids` 二选一，单次 ≤20 |
| `noa_list_join_requests` | `joinPolicy` | 群 | 拉取入群申请（`cursor`、`limit` ≤50）；每条带 `user_id` 与可直接回传的 `flag` |
| `noa_handle_join_request` | `joinPolicy` | 群 | 审批：`op`=`approve`/`decline`、`join_request_id`、`reject_reason`、`add_to_member_blacklist` |
| `noa_list_join_policies` / `noa_delete_join_policy` | `joinPolicy` | 群 | 自动审批策略列表 / 删除 |
| `noa_get_mute_state` | `groupAdmin` | 群 | 全员禁言规则 + 成员禁言列表 |
| `noa_set_member_mutes` | `groupAdmin` | 群 | 批量禁言：`members[]`（`op`=`add`/`update`/`del`、`mute_expire_at`），单次 ≤20 |
| `noa_list_blacklist` / `noa_update_blacklist` | `groupAdmin` | 群 | 黑名单查询（`limit` ≤100）/ 增删（单次 ≤20） |
| `noa_get_group_bot_state` | `groupAdmin` | 群 | 机器人群内状态（`recv_msg_setting` / `member_role` 等） |
| `noa_upload_media_image` / `noa_list_media_images` / `noa_delete_media_image` | `material` | 全局 | 素材图片上传（URL/本地/`base64://`，≤10MB）/ 查询 / 删除 |
| `noa_generate_url_link` | `share` | 全局 | 生成机器人分享链接；`callback_data` ≤32 |

dsh 专属（1 个；仅 dsh 插件内可用）：

| 动作 | 开关 | 场景 | 说明 |
|---|---|---|---|
| `noa_dsh_chat` | `dshChat.enable` | 全局 | 把 QQ 输入交回 dsh AI，返回 `{reply, conversation_id, restricted}`；`restrictTools` 控制是否禁止一切读写改工具 |

```jsonc
{ "action": "noa_stream_begin", "params": { "user_id": 10000000000002, "content": "正在生成…" } }
// data: { "stream_id": "a1b2...", "index": 1, "remain_msg_len": 1234, "passive": true }
{ "action": "noa_stream_append", "params": { "stream_id": "a1b2...", "content": "正在生成…已完成" } }
{ "action": "noa_stream_end", "params": { "stream_id": "a1b2...", "content": "最终全文" } }
```

- `input_mode=replace`（默认）时 `append` / `end` 的 `content` 必须以上一次已下发内容为前缀，否则 `1400` 并提示平台错误码 `40007`。
- 同一流必须串行调用；上一帧未返回时再次调用返回 `1400`。
- `noa_stream_begin` 的 `ref_idx` 当前不支持（官方流式接口没有引用参数），传入会 `1400`。
- 流状态只在内存中，进程重启后旧 `stream_id` 失效。

---

## 6. 事件

### 6.1 会收到的事件

| 事件 | 触发 | 备注 |
|---|---|---|
| `message` + `message_type=group` | 群内 @ 机器人（`GROUP_AT_MESSAGE_CREATE`）；或群主开启全量模式后的任意群消息（`GROUP_MESSAGE_CREATE`） | `message` 为段数组、`raw_message` 为 CQ 串；额外带 `at_me` / `to_me`（见 §6.3） |
| `message` + `message_type=private`, `sub_type=friend` | 用户私聊机器人 | `at_me=false`、`to_me=true` |
| `notice` `group_increase` | 机器人入群（`GROUP_ADD_ROBOT`）；成员入群需 intents `1<<24` | 机器人入群时 `user_id=self_id` |
| `notice` `group_decrease` | 机器人被移出（`GROUP_DEL_ROBOT`）；成员退群/被移出需 intents `1<<24` | 机器人被移出为 `sub_type=kick_me`；`GROUP_MEMBER_QUIT` → `leave`，`GROUP_MEMBER_REMOVE` → `kick` |
| `notice` `noa_interaction` | 用户点击按钮 / 快捷菜单（`INTERACTION_CREATE`） | 需 `noa.ext.interaction=true` 且 intents 含 `1<<26`；type 11/12 默认 3 秒内自动 ACK |
| `message_sent` | 适配器成功发出消息后 | `post_type="message_sent"`；带 `message_id` / `target_id` / `group_id` / `message` / `raw_message` |
| `notice` `friend_add` | 好友添加完成 | 需平台权限 |
| `notice` `noa_friend_del` | 用户删除机器人 | 需 `noa.ext.events=true` |
| `notice` `noa_group_msg_setting` / `noa_c2c_msg_setting` | 群管理员/用户开关机器人主动消息推送 | 需 `noa.ext.events=true`；字段 `enabled` |
| `notice` `noa_subscribe_status` | 订阅消息授权状态变化 | 需 `noa.ext.events=true`；`result[]` 原样透出 |
| `request` `group` `sub_type=add` | 入群申请 | `flag`（`group:member:join_request_id`）供审批使用；另带 `join_request_id` / `verify_info` / `auto_approved` |
| `request` `friend` | 好友验证 | 需平台权限 |
| `meta_event` `lifecycle` / `heartbeat` | 连接/每 30 秒 | — |

### 6.2 收不到的事件

- **撤回通知**（`group_recall` / `friend_recall`）：官方平台不推送撤回事件；
- `group_ban`、`group_upload`、`group_admin`、戳一戳、频道（guild）事件：一期未映射；
- `input_notify`（正在输入）：它是**出站**字段，平台不推对应事件；需要时由旧程序调用 `noa_send_typing`（§5.7）。
- `INTERACTION_CREATE` 只有在 `noa.ext.interaction=true` 且 intents 含 `1<<26` 时才投递；否则不会产生 `noa_interaction` 事件。自动 ACK 可用 `noa.autoAckInteraction=false` 关闭。

**成员进出事件**：映射已实现。适配器默认订阅 `1<<25 | 1<<24`；若机器人没有群成员事件权限，平台会以 `4013/4014` 拒绝 Identify，适配器自动回退到 `1<<25`（日志会告警），此时收不到成员事件，但消息收发不受影响。需要固定 intents 时在配置里写 `"intents": <整数>`（显式值不再自动回退）。

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
- **引用关系（接收）**：官方只给 `message_scene.ext.ref_msg_idx`，没有对应可查询的 `msg_id`，因此入站不生成 `reply` 段。
- **引用回复（发送）**：`reply` 段会从消息缓存取官方 `REFIDX` 填 `message_reference`；缓存里没有该消息时正文照发，回包 `quoted:false` + `warning`。
- 以上是接收侧降级，不代表可以把这些段原样发回去；发送能力以 §4.1 为准。

---

## 7. 错误码与排查

| 现象 | 原因与处理 |
|---|---|
| `401` / WS 握手失败 | token 不匹配；检查 `onebot.accessToken` 与请求头/query |
| 普通 HTTP 返回 `426` | 预期行为：本适配器没有 HTTP API，请走 WS |
| `retcode=1400 未知 group_id` | 群尚未“见过”（机器人未入群/无人 @ 过）；先让机器人收到该群消息 |
| `retcode=1400 未知 user_id` | 用户尚未私聊过机器人 |
| `retcode=1400 被动回复窗口已关闭` | 群 5 分钟/5 条或单聊 60 分钟/4 条用尽；改用 `passiveOverflow: "proactive"` 或等待 |
| `retcode=1400` 且 message 含“分片上传”/平台文件错误 | 文件超过官方硬上限（200MB）或分片上传失败；查看平台错误码 |
| `retcode=1400` 且 message 含“@用户 / markdown” | 群聊 @具体成员只在 `noa_markdown` 消息中生效；启用 `noa.ext.markdown` 后加 `noa_markdown` 段，或改纯文本 |
| `retcode=1400` 且 message 含“单聊不支持 @” | 单聊没有 @ 能力；去掉 at 段 |
| 平台错误码 `11253` | 群成员/群信息接口仅白名单机器人可用；联系平台运营申请权限 |
| `retcode=1404` 且 message 含“未启用” | 对应 `noa.ext.*` 开关为 `false`；在配置中启用后重试 |
| 流式返回平台 `40007` | `input_mode=replace` 时 `content` 不是累计全文；改成完整正文，或改用 `input_mode=append` |
| 收不到 `noa_interaction` | `noa.ext.interaction` 未启用，或 `intents` 未包含 `1<<26`；显式设置 `intents=1<<25\|1<<24\|1<<26` |
| `@全体成员` 发送失败 | 群聊 @全体需要机器人是群管理员，且每群每天仅 1 次；平台错误原样返回 |
| `retcode=1400` 且 message 含“系统表情” | 官方表情标签仅文字子频道可用；群/单聊不要发 face 段 |
| 回包 `retcode=0` 但 `quoted=false` | 引用目标不在缓存或无 REFIDX；正文已发送，只是没有引用气泡（同时带 `warning`） |
| `retcode=1400` 且 message 带平台错误码 | 富媒体上传/发送、禁言、审批等平台侧失败；按错误码排查（`40034105` 无主动消息权限、`40034100` 超频、`40034004` 转存失败等） |
| `retcode=1404 …` | 官方平台无该能力或扩展未启用，按 `message` 降级处理 |
| 日志出现 `4013/4014` 后自动重连 | 机器人无群成员事件权限；适配器已回退 `1<<25`，消息功能不受影响 |
| 平台错误码 `40034105` | 机器人没有主动消息权限；群聊还需群主开启「机器人主动在群聊内发言」 |
| 平台错误码 `40034100` | 主动消息超频；降低频率或等待 |
| 撤回自己的消息报“不在本地缓存” | 消息不是本进程发送的（重启前/缓存淘汰），或已超过 2 分钟；见 §5.1 |
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
  "intents": 0,
  "onebot": {
    "enable": true,
    "mode": "both",
    "accessToken": "change-me",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": ["ws://127.0.0.1:6700"]
  },
  "noa": {
    "ext": {
      "markdown": true,
      "keyboard": true,
      "card": false,
      "interaction": true,
      "typing": false,
      "menu": false,
      "joinPolicy": false,
      "stream": false,
      "wakeup": false,
      "groupAdmin": false,
      "material": false,
      "share": false,
      "events": false
    },
    "autoAckInteraction": true,
    "interactionRaw": false
  }
}
```

> 启用互动事件时，`intents` 必须显式包含 `1<<26`：写十进制 `117440512`（`1<<25 | 1<<24 | 1<<26`）。`intents: 0` 只自动订阅 `1<<25 | 1<<24`，收不到 `INTERACTION_CREATE`；`npm run doctor` 会提示这一点。

启动：

```bash
set NOA_APP_ID=你的AppID
set NOA_APP_SECRET=你的AppSecret
npm start
```

旧程序作为 WS 服务端监听 `127.0.0.1:6700`；本适配器按 `reverseUrls` 主动拨号连接，连上后推送事件、接收动作。若用正向 WS，则改为旧程序连接 `ws://127.0.0.1:7791/ws?access_token=change-me`。

---

## 9. 已知限制（一期）

1. 富媒体支持公网 URL、≤5MB 本地/`base64://` 直传，>5MB 自动走分片上传（官方硬上限 200MB）。`noa/1` 扩展（markdown/模板/keyboard/图文卡片/按钮互动/流式/召回/菜单面板/群管理与素材）已实现但默认关闭；启用后群聊 @具体成员走 `noa_markdown`，标准文本通道仍明确失败（`1400`），群聊 @全体可用。
2. `delete_msg` 只能撤回本进程发出、2 分钟内的消息（见 §5.1）。
3. 成员进出事件随默认的 `1<<25 | 1<<24` 一起订阅；机器人无权限时平台 `4013/4014` 会触发自动回退 `1<<25`，此时收不到成员事件（见 §6.2）。
4. 无 WebUI、配置热更新、文件日志；群目录不能手动加群/设别名。
5. 官方 2026-09-03 新增的群成员/互动/菜单/流式接口与群管理/素材接口尚未全部真机验证；群成员、群信息、黑名单与 `bot_state` 需要平台白名单权限（`11253`），审批/禁言需要群管理员身份。
6. 正向 WS 只支持单一路径，不支持 `/api` + `/event` 分离模式。
7. 接收侧 101/102/103 元素与卡片只做文本/附件降级，不生成 `reply` 段；C2C 事件的 `msg_elements`/`ark_data` 尚未展开（主要出现在全量群消息）。
8. 全量群消息依赖群主在手机 QQ 手动开启；PC 端 QQ 暂无该入口。
9. `message_sent` 是适配器自己广播的（包括触发本次发送的客户端也会收到）；旧程序需要按 `post_type` 过滤，避免把机器人自己的消息当成用户输入。
10. 互动事件可使用官方 `event_id` 被动回复：`send_group_msg` / `send_private_msg` / `send_msg` 传 `event_id`（与 `msg_id` 二选一）即可；不传时仍走最近一条消息的被动窗口。官方按场景限制可回传的事件类型，错误码原样透出。
11. `noa_stream_begin` 不支持 `ref_idx`（官方流式接口无引用参数）；流状态只在内存，进程重启后失效。
