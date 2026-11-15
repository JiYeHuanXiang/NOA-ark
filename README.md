# noa-ark

把 **QQ 官方机器人开放平台**（`api.bot.qq.com`，v2 WSS + REST）翻译成 **[OneBot v11](https://github.com/botuniverse/onebot-11)** 的独立适配器，让 go-cqhttp 时代的旧 OneBot 程序（NoneBot、Koishi、zerobot 插件等）可以像连接 NapCat / go-cqhttp 一样继续运行。

> 状态：`0.1.0`，早期版本。只使用 QQ 官方开放平台能力；不做 QQ 客户端协议逆向、不模拟客户端登录、不碰非官方通道。平台不支持或本适配器未接线的动作会**明确失败**，不会静默成功。

```
QQ 用户
   │
   ▼
QQ 开放平台（api.bot.qq.com，WSS + REST）
   │
   ▼
noa-ark
   └─ OneBot v11 正向 WS / 反向 WS
```

## 特性

- **OneBot v11**：38 个标准动作（其中 16 个平台无能力/未接线的动作明确拒绝）、消息 / 通知 / 请求事件、正向 WS 与反向 WS。
- **稳定的伪 QQ 号**：官方只有 openid；`mapped` 模式会持久化映射成可反查的伪号。
- **被动回复窗口**：按官方 `msg_id` + 递增 `msg_seq` 记账；超窗可显式失败或转主动消息。
- **富媒体**：公网 URL、≤5MB 本地文件 / `base64://` 直传，>5MB 自动分片上传（官方硬上限 200MB）；入站图片/语音可缓存为本地文件。
- **群成员**：列表、详情、移除成员（官方白名单接口，底层为批量接口）。
- **可选扩展 `noa/1`**：markdown（含模板/素材图片）、内嵌键盘、图文卡片、互动事件、菜单/面板读写、入群申请与自动审批、群管理（禁言/黑名单/群状态）、单聊流式、互动召回、分享链接与补充通知事件。
- **dsh 组合包**：可作为 DeepSeek Harness 插件加载，接管已运行的 `dsh-qqbot`，对外提供 OneBot 正/反向 WS，并与 dsh 做回复隔离。

## 快速开始

要求 **Node.js >= 20.3**。先在 [QQ 开放平台](https://q.qq.com/) 创建机器人，获取 AppID 与 AppSecret。

```bash
git clone <repo-url> noa-ark
cd noa-ark
npm install
npm run build
```

凭据推荐用环境变量传入（不会写入日志）：

```bash
# Linux / macOS
export NOA_APP_ID="你的 AppID"
export NOA_APP_SECRET="你的 AppSecret"
npm start
```

```powershell
# Windows PowerShell
$env:NOA_APP_ID="你的 AppID"
$env:NOA_APP_SECRET="你的 AppSecret"
npm start
```

也兼容 `QQBOT_APPID` / `QQBOT_SECRET`。配置文件里的 `appId` / `appSecret` 仅作为回退，优先级低于环境变量；不建议把 secret 写进配置文件。

在 QQ 中把机器人添加到群或加为好友后，再启动适配器。

启动后默认监听（仅绑定 `127.0.0.1`，OneBot 仅 WebSocket）：

| 协议 | 端点 |
|---|---|
| OneBot v11 正向 WS | `ws://127.0.0.1:7791/ws`（普通 HTTP 请求返回 426） |
| OneBot v11 反向 WS | 适配器主动连接 `onebot.reverseUrls[]` |

鉴权：`Authorization: Bearer <accessToken>` 或 `?access_token=`；token 为空表示不鉴权，**仅限本机使用**。

## 配置

复制 `config.example.json` 到 `~/.noa/config.json`（或 `NOA_CONFIG` 指向的位置），按需修改。最小配置示例：

```json
{
  "onebot": {
    "enable": true,
    "mode": "both",
    "accessToken": "",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": []
  }
}
```

需要反向 WS 时，把下游程序地址填入 `reverseUrls`；`onebot.mode` 可限定只开正向（`forward`）、只连反向（`reverse`）或两者（`both`，默认）。

常用配置项：

| 键 | 说明 |
|---|---|
| `idMode` | `mapped`（默认）：openid → 稳定伪 QQ 号；`passthrough`：直接透传 openid 字符串 |
| `passiveOverflow` | 被动窗口用尽后：`fail`（默认，明确失败）或 `proactive`（转主动消息，受本地配额节流） |
| `intents` | `0`（默认，自动）：订阅 `1<<25 \| 1<<24`，平台拒绝群成员事件时回退 `1<<25`；填正整数则原样使用 |
| `onebot.mode` | WS 模式：`forward`（只开正向服务端）/ `reverse`（只连 `reverseUrls`）/ `both`（默认） |
| `onebot.wsPort` / `onebot.wsPath` | 正向 WS 监听端口与路径（默认 `7791` / `/ws`） |
| `onebot.reverseUrls` | 反向 WS：适配器拨号连接旧程序 |
| `noa.ext.*` | `noa/1` 扩展开关，全部默认 `false`；未启用时对应段/动作明确失败 |
| `noa.autoAckInteraction` | `INTERACTION_CREATE`（type 11/12）是否先自动 ACK `code=0`（默认 `true`） |
| `noa.interactionRaw` | 互动事件里是否附带官方原始 `d`（默认 `false`） |

<details>
<summary>完整配置示例（含 noa/1 开关）</summary>

```json
{
  "idMode": "mapped",
  "passiveOverflow": "fail",
  "intents": 0,
  "onebot": {
    "enable": true,
    "mode": "both",
    "accessToken": "",
    "wsPort": 7791,
    "wsPath": "/ws",
    "reverseUrls": []
  },
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

</details>

环境变量：

| 变量 | 作用 |
|---|---|
| `NOA_APP_ID` / `NOA_APP_SECRET` | 机器人凭据（也兼容 `QQBOT_APPID` / `QQBOT_SECRET`） |
| `NOA_CONFIG` | 配置文件路径 |
| `NOA_HOME` | 数据与默认配置根目录（默认 `~/.noa`） |
| `NOA_DEBUG=1` | 输出调试日志（可能包含消息摘要，注意不要公开贴出） |

## 能力边界

- **只有 openid，没有 QQ 号**：`mapped` 模式分配稳定伪号，映射持久化在 `~/.noa/data/registry/`。
- **群聊默认只收 @ 机器人消息**：群主在手机 QQ 的群设置 → 机器人里把「机器人可获取的群聊消息范围」设为「获取群内全部消息」后，才能收到未 @ 的群消息。
- **重复投递**：同一官方 `msg_id` 在 5 分钟内只向下游投递一次，覆盖网关重连、平台重试等场景。
- **被动窗口**：群 5 分钟 / 5 条，单聊 60 分钟 / 4 条；超窗按 `passiveOverflow` 处理。
- **主动消息**：受平台配额与用户开关限制，可能返回 `40034105`（无权限）或 `40034100`（超频）。
- **富媒体**：文本与图片混排会拆成多条官方消息，各自消耗一次被动槽；本地文件 >5MB 自动走分片上传。
- **群成员接口**：仅官方白名单机器人可用；平台错误 `11253` 会转成明确的 OneBot 失败。
- **媒体缓存**：`get_image` / `get_record` 下载到 `~/.noa/data/cache/media`，单文件上限 20MB、20 秒超时；拒绝本机/内网字面量地址与跳入内网的重定向。
- **明确拒绝**：好友列表、管理员任免、群名片、头衔、匿名、退群、群聊 @具体成员（标准文本通道）、合并转发、json/xml 卡片、消息撤回事件下发等。

### 引用回复与 @

- `reply` 段使用消息缓存里的官方 `REFIDX`；取不到时退化为普通被动回复并返回 `quoted:false`。
- 群聊 `at(qq=all)` 发送为 `<qqbot-at-everyone />`，机器人需为群管理员，每群每天 1 次。
- 群聊 `@具体成员` 只在 `noa_markdown` 消息里转换为 `<qqbot-at-user />`；标准文本通道明确失败。
- 单聊不支持 @；系统表情明确拒绝。

## 扩展协议 noa/1（默认关闭）

标准协议覆盖不到的官方能力通过 `noa_*` 段 / 动作 / 事件提供，需在 `noa.ext.*` 显式启用。未启用时一律明确失败，不静默降级。完整协议见 **[文档](文档)**。

- **消息段**：`noa_markdown`（`msg_type=2`）、`noa_keyboard`（内嵌按钮）、`noa_card`（`msg_type=8` 图文卡片）。
- **事件**：`INTERACTION_CREATE` → `notice/noa_interaction`；需要 `intents` 包含 `1<<26`。
- **动作**：P1–P6 的 `noa_send_typing`、`noa_ack_interaction`、`noa_set_menu`、`noa_set_panel` / `noa_list_panels`、`noa_set_group_add_request_policy`、`noa_stream_begin` / `append` / `end`、`noa_send_wakeup`；P7 新增菜单/面板读写、入群申请列表与审批、禁言/黑名单/群状态、素材图片、分享链接等 18 个动作（见 文档 §11）。
- **发送侧**：`send_*` 支持可选 `event_id` 被动回复；本地富媒体 >5MB 自动分片上传。
- `get_version_info` 会返回 `noa_ext_version: "noa/1"` 与已启用能力列表。

## dsh 插件：接管 dsh-qqbot

本仓库同时是一个 **dsh（DeepSeek Harness）组合包**。安装到 dsh profile 后，它不另开 QQ 连接，而是旁路已运行的 `@tencent-connect/dsh-qqbot`：

- 入站消息在中间件之前从 `handleInboundMessage` 取出，非消息事件从 `rawEvent` 取出，统一转成 OneBot v11 事件；
- OneBot 动作走官方 REST，复用运行中 QQBot 的凭据；
- 对外提供 OneBot 正向 / 反向 WS。

默认 `takeover.isolation: auto`：**有 OneBot 客户端在线时，dsh-qqbot 暂停处理入站消息**（包括斜杠命令与 typing），避免 dsh 与外接 OneBot 程序同时回复；客户端全部断开后 dsh 自动恢复。

```bash
npm run build
dsh plugin --profile <profile> add link:/absolute/path/to/noa-ark
# Windows 路径示例：
# dsh plugin --profile <profile> add link:C:\path\to\noa-ark
# 没有全局 dsh 时，可用 npx @deepseek-ai/dsh@<version> plugin ...
# 重启 dsh
```

前提是 dsh-qqbot 已在当前 profile 的 `dsh.profile.bundles` 中启用并完成 QQ 绑定。完整安装、配置、隔离语义与排障见 **[文档](文档)**。

## 开发与测试

```bash
npm test          # vitest
npm run typecheck
npm run build
npm run doctor    # 检查配置、凭据与数据目录
```

测试覆盖协议转换、伪号映射、被动窗口、主动配额、动作路由、事件映射、富媒体、群成员白名单、媒体缓存、`noa/1`、dsh 接管与端到端链路。

## 项目结构

```
src/
  config.ts            配置模型与加载
  core/                openid 映射、被动窗口、主动配额、媒体缓存、消息段转换
  official/            官方 WSS 网关与 v2 REST
  onebot/              OneBot v11 事件、动作路由、正向 / 反向 WS
  noa/                 noa/1 扩展（事件、动作路由、服务、入群审批）
  dsh/                 dsh 组合包入口与 dsh-qqbot 接管层
  bridge.ts            事件 fan-out 与发送实现
  cli.ts               start / doctor
cordis.patch.yml       dsh 组合包默认配置
locale/                dsh 插件管理器显示元数据
docs/                  协议映射、用户手册、noa/1、dsh 插件文档
```

## 文档

- **[文档](文档)**：官方能力与 OneBot v11 的逐条映射、能力边界。
- **[docs/USER-MANUAL.md](docs/USER-MANUAL.md)**：动作、事件、错误码与常见问题。
- **[文档](文档)**：`noa/1` 扩展调用协议。
- **[文档](文档)**：dsh 插件安装、接管与回复隔离。

## 安全

- 所有监听默认只绑定 `127.0.0.1`；对公网暴露请自行加反向代理与鉴权。
- 非空 `accessToken` 会校验 `Authorization: Bearer` 或 `?access_token=`。
- 凭据不会写入日志；`NOA_DEBUG=1` 会输出更多消息摘要，排查后请关闭。
- 媒体缓存会拒绝本机/内网字面量地址与跳入内网的重定向，但不做 DNS 解析后的 IP 固定。

## 已知限制与后续计划

- `noa/1` 灰度能力（菜单 / 面板 / 群管理 / 素材 / 流式）的真机验证；全员禁言端点真机确认。
- 更多群管理接口。

欢迎提交 issue / PR。修改协议映射或新增动作前，请先阅读 `文档` 的能力边界。

## License

本项目以 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）** 发布，完整条款见 [LICENSE](LICENSE)。

- 你可以自由使用、修改、分发本项目；分发衍生作品时须继续以 AGPL-3.0 授权并提供源码。
- 修改后通过网络向用户提供服务时，须按 AGPL 第 13 条向这些用户提供对应的完整源码（Corresponding Source）。
- 原样运行、不对外提供服务不触发额外的源码提供义务。

### 治理说明

本项目由个人立项维护。贡献请使用带 `Signed-off-by` 的提交（DCO），本项目不要求签署 CLA，贡献者保留其贡献的版权。若主仓库停止维护，社区可自由 fork、修改并以新名称继续发布，无需取得额外授权；继续发布时请遵守 AGPL 的源码提供义务。
