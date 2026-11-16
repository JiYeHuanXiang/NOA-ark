# NOA 方舟 OneBot 桥

把 QQ 官方机器人（QQ 开放平台）转成 OneBot v11：既可以独立进程运行，也可以作为 dsh 组合包接管已安装的 `@tencent-connect/dsh-qqbot`，并在 OneBot 客户端与 dsh 之间做回复隔离。

## 能力

- OneBot v11 正向 WebSocket：`ws://127.0.0.1:7791/ws`；也可配置反向 WebSocket。
- QQ 群聊/私聊消息转 OneBot 事件；OneBot 动作走官方 REST，复用同一凭据。
- 回复隔离：开启后 dsh agent 暂停处理入站消息，避免 dsh 与外接 OneBot 程序同时回复。
- 可选 `noa/1` 扩展动作：markdown、键盘、图文卡片、流式、群管理、素材、`noa_dsh_chat` 等。

## 设置页

在 dsh Desktop 打开「设置 → NOA 方舟」即可进入设置表单；也可以从「插件管理 → noa-ark」的组件行点击「配置」进入同一个表单。

- OneBot 服务：启用开关、WS 模式（正向 / 反向 / 双向）、正向端口与路径、反向地址。
- 回复隔离：`auto` / `always` / `off`。
- dsh AI 对话：是否允许 `noa_dsh_chat`，以及是否限制为「仅对话回复」。

鉴权令牌不会回显；需要时在 profile 配置里设置 `onebot.accessToken`。`takeover.appId`、`takeover.autoAckInteraction`、`noa.ext.*` 等其余配置仍在 profile 的 `cordis.patch.yml` 中编辑。

## 回复隔离

- `auto`（默认）：有至少一个 OneBot 客户端在线时，dsh 暂停入站处理。启动桥的第一条消息可能仍由 dsh 处理；可再发一条，或等客户端重连后再测。
- `always`：dsh 不再回复 QQ 消息。请先确认 OneBot 客户端已接管，否则消息无人回复。
- `off`：dsh 与 OneBot 都可能回复，不推荐。

隔离只影响 dsh-qqbot 的中间件/agent 路径，不改变 OneBot 事件流。

## 使用步骤

1. 确认 profile 已启用 `@tencent-connect/dsh-qqbot`，且 QQ 连接已就绪。
2. 启动 OneBot 客户端，连接 `ws://127.0.0.1:7791/ws`（或把 `reverseUrls` 指向该客户端）。
3. 发送 `get_status` 确认桥在线，然后使用标准 OneBot 动作。
4. 隔离生效时若希望 dsh AI 回答，开启 `dshChat.enable` 后调用 `noa_dsh_chat`；动作只返回文本，不代发 QQ 消息。

## 限制

- 必须由 dsh-qqbot 维持 QQ 连接；本包不会另开第二条 QQ 连接。
- 修改磁盘文件后需要重启 dsh；设置页中的易变字段（OneBot 绑定、隔离、dsh AI 开关）保存后即时生效。
- 用 `file:` 安装会固定当前打包快照；仓库更新后需重新打包并重装。
- OneBot 监听只绑定 `127.0.0.1`；对公网暴露需自行加反向代理与鉴权。

本包随附本页及其中文版作为插件说明。
