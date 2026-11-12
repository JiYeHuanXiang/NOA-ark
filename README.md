# noa-ark · NOA 方舟计划

把 **QQ 官方机器人开放平台**（`api.bot.qq.com`，v2 WSS + REST）翻译成 **OneBot v11** 与 **Milky v1.3** 双协议的独立适配器，让 go-cqhttp 时代的旧 OneBot 程序（NoneBot / Koishi / zerobot 插件等）可以像连接 NapCat/go-cqhttp 一样登录运行。

- 全量能力清单与逐条映射：见 **[文档](文档)**
- 动作/事件/错误码使用手册：见 **[docs/USER-MANUAL.md](docs/USER-MANUAL.md)**
- 设计红线：只使用官方开放平台能力；**不做** QQ 客户端协议逆向、不模拟客户端登录、不碰非官方通道。
- 平台做不到的动作（踢人、好友列表、群成员列表、@全体、json/xml 卡片……）一律以标准失败明确拒绝，绝不静默成功。

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

## 配置

复制 `config.example.json` 到 `~/.noa/config.json`（或 `NOA_CONFIG` 指向的位置）：

```json
{
  "idMode": "mapped",
  "passiveOverflow": "fail",
  "onebot": {
    "enable": true,
    "accessToken": "",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": ["ws://127.0.0.1:6700"]
  },
  "milky": { "enable": false, "port": 7792, "accessToken": "" }
}
```

| 键 | 说明 |
|---|---|
| `idMode` | `mapped`（默认）：openid → 稳定伪 QQ 号（持久映射、可反查）；`passthrough`：直接透传 openid 字符串 |
| `passiveOverflow` | 被动窗口用尽后：`fail`（默认，明确失败）或 `proactive`（转入主动消息，受本地配额节流） |
| `onebot.wsPort` / `onebot.wsPath` | 正向 WS 监听端口与路径（默认 7791 / `/ws`） |
| `onebot.reverseUrls` | 反向 WS：适配器拨号连接旧程序（推荐，最省事） |
| `milky.enable` | 是否启用 Milky v1.3 端点（一期只实现核心动作子集） |

环境变量：`NOA_APP_ID` / `NOA_APP_SECRET`（兼容 `QQBOT_APPID` / `QQBOT_SECRET`）、`NOA_CONFIG`、`NOA_HOME`、`NOA_DEBUG=1`。

## 平台边界（详见 文档 §6）

- **只有 openid，没有 QQ 号** → `mapped` 模式分配稳定伪号（从 10^13 起，持久化到 `data/registry/idmap.json`）。
- **群聊默认只收 @ 机器人消息**；群主在手机 QQ 群设置 → 机器人里把「机器人可获取的群聊消息范围」设为「获取群内全部消息」后，即可收到未 @ 的 `GROUP_MESSAGE_CREATE`（这不是开放平台权限申请，详见 [USER-MANUAL §6.3](docs/USER-MANUAL.md)）。
- **重复投递**：同一官方 `msg_id` 在 5 分钟内只向下游投递一次（覆盖两个事件名携带同一消息、网关重连/平台重试等场景）。
- **被动窗口**：群 5 分钟 / 5 条，单聊 60 分钟 / 4 条；超窗按 `passiveOverflow` 处理。
- **主动消息**：受平台配额与用户开关限制（`40034105` 无权限、`40034100` 超频）。
- **明确拒绝**：好友列表、群成员列表、踢人、管理员、群名片、头衔、匿名、退群、@全体、合并转发、json/xml 卡片、消息撤回事件下发等。

## Milky 一期覆盖

`send_private_message` / `send_group_message` / `recall_private_message` / `recall_group_message` / `get_message` / `mark_message_as_read` / `get_login_info` / `get_impl_info` / `set_group_member_mute` / `set_group_whole_mute` / `accept_group_request` / `reject_group_request`。

其余 API（好友域、文件域、公告/精华/表情回应/nudge 等）返回 `retcode: -404` 明确失败，二期补齐。

## 测试

```bash
npm test          # vitest
npm run typecheck
npm run build
```

测试覆盖：CQ 码 ⇄ 段数组往返、伪号映射持久化、被动窗口状态机、主动配额、38 动作三档路由、官方事件 → v11 事件映射（含新式 `<@openid>` / `mentions.is_you` 判定与 `at_me`/`to_me`）、`msg_elements`/ark 卡片文本降级、按 `msg_id` 去重、WS 鉴权与回包（HTTP 请求返回 426）、Milky `/api` 与 SSE、以及 **mock 官方网关 → 反向 WS 旧程序 → send_group_msg → mock REST（带 msg_id + msg_seq）** 的端到端链路。

## 目录

```
src/
  config.ts              配置模型与加载（凭据仅环境变量）
  types.ts               日志 / 脱敏 / 共享类型
  core/idmap.ts          openid ⇄ 伪号 / message_id ⇄ 伪 message_id（持久化 + LRU）
  core/msgseq.ts         per-msg_id 被动窗口与 msg_seq
  core/quota.ts          主动消息本地配额
  core/segments.ts       官方内容/附件 ⇄ CQ ⇄ OneBot 段 ⇄ Milky 段
  official/gateway.ts    官方 WSS 网关（Identify / Resume / 心跳 / 指数退避）
  official/rest.ts       官方 v2 REST（消息 / 撤回 / 富媒体 / 禁言 / 审批）
  onebot/events.ts       官方事件 → OneBot v11 事件
  onebot/actions.ts      38 个公开动作三档路由
  onebot/server.ts       正向 WS（HTTP API 与 HTTP 上报已移除）
  onebot/reverse.ts      反向 WS 客户端
  milky/actions.ts       Milky v1.3 动作子集
  milky/server.ts        /api/:api + /event（SSE/WS）
  bridge.ts              事件 fan-out + 发送实现（被动窗/配额）
  cli.ts                  start / doctor
文档           双协议映射总文档
docs/USER-MANUAL.md      动作/事件/错误码使用手册
```

## 下期（见 文档 §9）

Milky 全量动作与三通道、独立进程拆分、markdown/keyboard 权限路径、流式消息与互动召回、富媒体缓存代理。
