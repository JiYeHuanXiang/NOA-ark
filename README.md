# noa-ark · NOA 方舟计划

把 **QQ 官方机器人开放平台**（`api.bot.qq.com`，v2 WSS + REST）翻译成 **OneBot v11** 与 **Milky v1.3** 双协议的独立适配器，让 go-cqhttp 时代的旧 OneBot 程序（NoneBot / Koishi / zerobot 插件等）可以像连接 NapCat/go-cqhttp 一样登录运行。

- 全量能力清单与逐条映射：见 **[文档](文档)**
- 动作/事件/错误码使用手册：见 **[docs/USER-MANUAL.md](docs/USER-MANUAL.md)**
- 标准协议外的扩展调用协议：见 **[文档](文档)**（`noa/1`，默认关闭）
- dsh 插件（接管 dsh-qqbot + OneBot 正/反向 WS）：见 **[文档](文档)**
- 设计红线：只使用官方开放平台能力；**不做** QQ 客户端协议逆向、不模拟客户端登录、不碰非官方通道。
- 平台无能力或本适配器未接线的动作（好友列表、管理员任免、群名片、头衔、匿名、改群名、合并转发、json/xml 卡片……）一律以标准失败明确拒绝，绝不静默成功。

## 快速开始

要求 Node.js >= 20.3。

```bash
npm install
npm run build

# 凭据只从环境变量读取（不落盘）
set NOA_APP_ID=你的AppID
set NOA_APP_SECRET=你的AppSecret
npm start            # 等价于 node bin/noa.mjs start
```

默认端点（仅绑定 127.0.0.1；OneBot 仅 WebSocket）：

| 协议 | 端点 |
|---|---|
| OneBot v11 正向 WS | `ws://127.0.0.1:7791/ws`（唯一入站通道；普通 HTTP 请求返回 426） |
| OneBot v11 反向 WS | 适配器主动连接 `onebot.reverseUrls[]` |
| Milky v1.3 | `http://127.0.0.1:7792/api/:api` + `/event`（SSE / WS） |

鉴权：`Authorization: Bearer <accessToken>` 或 `?access_token=`；token 为空表示不鉴权（仅限本机）。

## dsh 插件（接管 dsh-qqbot）

本仓库同时是一个 dsh 组合包。安装到 dsh profile 后，它不另开 QQ 连接，而是旁路
`@tencent-connect/dsh-qqbot` 正在使用的 QQBot 实例：入站消息在中间件之前从
`handleInboundMessage` 取出，非消息事件从 `rawEvent` 取出，统一转成 OneBot v11 事件；
OneBot 动作 → 官方 REST，并对外提供正向/反向 WS。

默认 `takeover.isolation: auto`：**有 OneBot 客户端在线时，dsh-qqbot 暂停处理入站消息**
（连斜杠命令和 typing 一起暂停），避免 dsh 与外接 OneBot 程序同时回复；客户端全部
断开后 dsh 自动恢复。

```bash
npm run build
dsh plugin --profile desktop add link:E:\114\noa-ark
# 重启 dsh（Desktop：~/.dsh/plugins/restart-dsh.cmd）
```

完整安装、配置、隔离语义与排障见 **[文档](文档)**。

## 配置

复制 `config.example.json` 到 `~/.noa/config.json`（或 `NOA_CONFIG` 指向的位置）：

```json
{
  "idMode": "mapped",
  "passiveOverflow": "fail",
  "intents": 0,
  "onebot": {
    "enable": true,
    "accessToken": "",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": ["ws://127.0.0.1:6700"]
  },
  "milky": { "enable": false, "port": 7792, "accessToken": "" },
  "noa": {
    "ext": {
      "markdown": false,
      "keyboard": false,
      "card": false,
      "interaction": false,
      "typing": false,
      "menu": false,
      "joinPolicy": false,
      "stream": false,
      "wakeup": false
    },
    "autoAckInteraction": true,
    "interactionRaw": false
  }
}
```

| 键 | 说明 |
|---|---|
| `idMode` | `mapped`（默认）：openid → 稳定伪 QQ 号（持久映射、可反查）；`passthrough`：直接透传 openid 字符串 |
| `passiveOverflow` | 被动窗口用尽后：`fail`（默认，明确失败）或 `proactive`（转入主动消息，受本地配额节流） |
| `intents` | `0`（默认，自动）：订阅 `1<<25 \| 1<<24`，平台以 `4013/4014` 拒绝群成员事件时自动回退 `1<<25`；填正整数则原样使用且不自动回退 |
| `onebot.wsPort` / `onebot.wsPath` | 正向 WS 监听端口与路径（默认 7791 / `/ws`） |
| `onebot.reverseUrls` | 反向 WS：适配器拨号连接旧程序（推荐，最省事） |
| `milky.enable` | 是否启用 Milky v1.3 端点（一期只实现核心动作子集） |
| `noa.ext.*` | noa/1 扩展开关：`markdown` / `keyboard` / `card` / `interaction` / `typing` / `menu` / `joinPolicy` / `stream` / `wakeup`，全部默认 `false`；未启用时对应段/动作明确失败 |
| `noa.autoAckInteraction` | `INTERACTION_CREATE`（type 11/12）是否先自动 ACK `code=0`（默认 `true`） |
| `noa.interactionRaw` | 互动事件里是否附带官方原始 `d`（默认 `false`） |

环境变量：`NOA_APP_ID` / `NOA_APP_SECRET`（兼容 `QQBOT_APPID` / `QQBOT_SECRET`）、`NOA_CONFIG`、`NOA_HOME`、`NOA_DEBUG=1`。

## 平台边界（详见 文档 §6）

- **只有 openid，没有 QQ 号** → `mapped` 模式分配稳定伪号（从 10^13 起，持久化到 `data/registry/idmap.json`）。
- **群聊默认只收 @ 机器人消息**；群主在手机 QQ 群设置 → 机器人里把「机器人可获取的群聊消息范围」设为「获取群内全部消息」后，即可收到未 @ 的 `GROUP_MESSAGE_CREATE`（这不是开放平台权限申请，详见 [USER-MANUAL §6.3](docs/USER-MANUAL.md)）。
- **重复投递**：同一官方 `msg_id` 在 5 分钟内只向下游投递一次（覆盖两个事件名携带同一消息、网关重连/平台重试等场景）。
- **被动窗口**：群 5 分钟 / 5 条，单聊 60 分钟 / 4 条；超窗按 `passiveOverflow` 处理。
- **主动消息**：受平台配额与用户开关限制（`40034105` 无权限、`40034100` 超频）。
- **富媒体发送**：走官方 `msg_type=7`；支持公网 URL 直传与 ≤5MB 本地 / `base64://` 直传，更大的本地文件明确失败（分片上传未实现）。文本与图片混排会拆成多条消息，各自消耗一次被动槽。
- **群成员（2026-09-03 白名单接口）**：`get_group_member_list` / `get_group_member_info` / `set_group_kick`（批量移除 + 可选拉黑）已接线；接口仅白名单机器人可用（平台错误 `11253`），列表 30 条/页、60 QPM，适配器最多拉 20 页（600 人）并告警截断。
- **媒体缓存**：`get_image` / `get_record` 把消息附件 URL 下载到 `data/cache/media` 并返回本地路径（单文件上限 20MB、20 秒超时；拒绝本机/内网字面量地址与跳入内网的重定向；不做 DNS 解析后的 IP 固定）；入站图片/语音段可直接把 `file` 传给它们。
- **引用回复 / @**：`reply` 段使用消息缓存中的官方 `REFIDX`（取不到时退化为普通被动回复并回传 `quoted:false`）；群聊 `at(qq=all)` 发送为 `<qqbot-at-everyone />`（机器人需为群管理员、每群每天 1 次）；群聊 `@具体成员` 在 `noa_markdown` 消息里转换为 `<qqbot-at-user />`，标准文本通道返回 `1400`；单聊不支持 @；系统表情明确拒绝。
- **明确拒绝**：好友列表、管理员任免、群名片、头衔、匿名、退群、群聊 @具体成员（标准文本通道）、合并转发、json/xml 卡片、消息撤回事件下发等。

## Milky 一期覆盖

`send_private_message` / `send_group_message` / `recall_private_message` / `recall_group_message` / `get_message` / `mark_message_as_read` / `get_login_info` / `get_impl_info` / `set_group_member_mute` / `set_group_whole_mute` / `accept_group_request` / `reject_group_request`。

其余 API（好友域、文件域、公告/精华/表情回应/nudge 等）返回 `retcode: -404` 明确失败，二期补齐。

## noa/1 扩展（默认关闭）

标准协议覆盖不到的官方能力通过 `noa_*` 段 / 动作 / 事件提供，需在 `noa.ext.*` 显式启用；未启用时一律明确失败，绝不静默降级。完整调用协议见 **[文档](文档)**。

- **消息段**：`noa_markdown`（`msg_type=2`）、`noa_keyboard`（内嵌按钮，挂在 text / markdown 上）、`noa_card`（`msg_type=8` 图文卡片）。`noa_ark` / `noa_embed` 群/单聊永久 `1404`。
- **事件**：`INTERACTION_CREATE` → `notice/noa_interaction`；需要显式把 `intents` 设为包含 `1<<26`。`type=11/12` 默认在 3 秒内自动 ACK `code=0`（可用 `noa.autoAckInteraction=false` 关闭后手动 `noa_ack_interaction`）。
- **动作**：`noa_send_typing`（单聊）、`noa_ack_interaction`、`noa_set_menu`、`noa_set_panel` / `noa_list_panels`（列表需官方必填 `scope`）、`noa_set_group_add_request_policy`、`noa_stream_begin` / `noa_stream_append` / `noa_stream_end`（单聊流式）、`noa_send_wakeup`（单聊互动召回）。
- `get_version_info` 会返回 `noa_ext_version: "noa/1"` 与已启用能力列表 `noa_ext[]`。

## 测试

```bash
npm test          # vitest
npm run typecheck
npm run build
```

测试覆盖：CQ 码 ⇄ 段数组往返、伪号映射持久化、被动窗口状态机、主动配额、动作三档路由、官方事件 → v11 事件映射（含新式 `<@openid>` / `mentions.is_you` 判定与 `at_me`/`to_me`）、`msg_elements`/ark 卡片文本降级、按 `msg_id` 去重、富媒体上传端点与 `msg_type=7`/引用 `message_reference`、出站段转换（@ 标签 / 回复提取 / 显式拒绝）、intents `4014` 回退、官方群信息合并、群成员白名单接口与分页、媒体缓存下载/命中/超限、`message_sent`、WS 鉴权与回包（HTTP 请求返回 426）、Milky `/api` 与 SSE、noa/1 段转换与组合校验、互动事件映射、noa_* 动作门控与流式生命周期、dsh 接管（handleInboundMessage 前置旁路 / rawEvent 非消息事件 / interaction 转发 / 凭据捕获 / 多 sink 卸载 / 入站隔离短路）、dsh 运行时（合成网关 → OneBot 事件 → 动作 → 官方 REST 被动回复）、插件配置归一化与 dsh-qqbot 启用检测，以及 **mock 官方网关 → 反向 WS 旧程序 → send_group_msg → mock REST（带 msg_id + msg_seq）** 的端到端链路。

## 目录

```
src/
  config.ts              配置模型与加载（凭据仅环境变量）
  types.ts               日志 / 脱敏 / 共享类型
  core/idmap.ts          openid ⇄ 伪号 / message_id ⇄ 伪 message_id（持久化 + LRU）
  core/msgseq.ts         per-msg_id 被动窗口与 msg_seq
  core/quota.ts          主动消息本地配额
  core/media-cache.ts    附件 URL → 本地文件缓存（get_image / get_record）
  core/segments.ts       官方内容/附件 ⇄ CQ ⇄ OneBot 段 ⇄ Milky 段
  official/gateway.ts    官方 WSS 网关（Identify / Resume / 心跳 / 指数退避）
  official/rest.ts       官方 v2 REST（消息 / 撤回 / 富媒体 / 禁言 / 审批 / 群成员 / 互动 / 流式）
  onebot/events.ts       官方事件 → OneBot v11 事件
  onebot/actions.ts      38 个标准动作 + noa_* 委派
  onebot/server.ts       正向 WS（HTTP API 与 HTTP POST 已移除）
  onebot/reverse.ts      反向 WS 客户端
  noa/events.ts          INTERACTION_CREATE → noa_interaction
  noa/router.ts          noa_* 动作路由与能力门控
  noa/service.ts         noa/1 官方实现（markdown/card/typing/流式/审批策略）
  noa/join-policy.ts     入群自动审批 strategy_id 持久缓存
  milky/actions.ts       Milky v1.3 动作子集
  milky/server.ts        /api/:api + /event（SSE/WS）
  bridge.ts              事件 fan-out + 发送实现（被动窗/配额）
  cli.ts                  start / doctor
  dsh/takeover.ts         dsh 内旁路 QQBot（handleInboundMessage / emit / 凭据捕获）
  dsh/plugin.ts           dsh 组合包入口（配置合并 / 隔离判定 / 桥生命周期）
cordis.patch.yml         dsh 组合包默认配置（插入 noa-ark 行）
locale/{zh,en}.json      dsh 插件管理器显示元数据
icon.svg                 dsh 插件图标
文档           双协议映射总文档
docs/USER-MANUAL.md      动作/事件/错误码使用手册
文档          标准协议外的 noa/1 扩展调用协议
文档       dsh 插件：接管 dsh-qqbot 与 OneBot 正/反向 WS
```

## 下期（见 文档 §9 与 文档 §9）

Milky 全量动作与三通道、独立进程拆分、富媒体分片上传（>5MB）、互动事件 `event_id` 被动回复、`noa/1` 灰度能力真机验证（menu/panels/stream）、更多群管理接口。
