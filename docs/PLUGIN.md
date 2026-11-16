# NOA Ark OneBot bridge

Exposes a QQ official bot (QQ Open Platform) as OneBot v11, either as a standalone process or as a dsh bundle that takes over the installed `@tencent-connect/dsh-qqbot` connection. It also isolates replies between OneBot clients and the dsh agent.

## What you get

- OneBot v11 forward WebSocket at `ws://127.0.0.1:7791/ws` and optional reverse WebSocket connections.
- QQ group and private messages translated to OneBot events; OneBot actions call the official REST API with the same credentials.
- Reply isolation: when enabled, the dsh agent pauses inbound handling so dsh and an external OneBot program do not both answer.
- Optional `noa/1` extension actions (markdown, keyboard, cards, stream, group management, media, `noa_dsh_chat`).

## Settings

Open **Settings → NOA Ark** in dsh Desktop, or click **Configure** on the component row under **Plugins → noa-ark**; both open the same form.

- OneBot service: enable, WS mode (forward / reverse / both), forward port and path, reverse URLs.
- Reply isolation: `auto` / `always` / `off`.
- dsh AI chat: allow `noa_dsh_chat`, and restrict the AI to chat-only replies.

The access token is intentionally not echoed in the form; set `onebot.accessToken` in the profile patch if you need authentication. Other keys (`takeover.appId`, `takeover.autoAckInteraction`, `noa.ext.*`) remain in the profile `cordis.patch.yml`.

## Reply isolation

- `auto` (default): dsh pauses inbound handling while at least one OneBot client is connected. The first message that starts the bridge may still be handled by dsh; send a follow-up or wait for the client reconnection.
- `always`: dsh never replies to QQ messages. Use this only after an OneBot client is connected, otherwise no one answers.
- `off`: dsh and OneBot may both reply; not recommended.

Isolation never changes the OneBot event stream. It only suppresses the dsh-qqbot middleware/agent path for inbound messages.

## Using it

1. Make sure `@tencent-connect/dsh-qqbot` is enabled in the profile and its QQ connection is ready.
2. Start the OneBot client and connect to `ws://127.0.0.1:7791/ws` (or point `reverseUrls` at it).
3. Send `get_status` to confirm the bridge is online, then use normal OneBot actions.
4. To let the dsh AI answer a message while isolation is active, enable `dshChat.enable` and call `noa_dsh_chat`; the action returns text only and does not send QQ messages.

## Limitations

- dsh-qqbot must be running; this bundle does not open a second QQ connection.
- Changes to files on disk require a restart of dsh. Volatile settings in the form (OneBot binding, isolation, dsh AI switches) apply without restarting.
- A `file:` installation pins the packaged snapshot. Rebuild and reinstall to pick up repository changes.
- The OneBot listener binds `127.0.0.1` only. Exposing it publicly requires a reverse proxy and authentication.

This page and its Chinese translation are the plugin documentation shipped with the package.
