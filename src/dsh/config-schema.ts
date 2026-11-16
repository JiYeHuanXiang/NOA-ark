import Schema from '@deepseek-ai/schemastery';

const OneBotSchema = Schema.object({
  enable: Schema.boolean()
    .default(true)
    .volatile()
    .description('启用 OneBot v11 服务'),
  mode: Schema.union(['forward', 'reverse', 'both'])
    .default('both')
    .volatile()
    .description('WS 模式：forward=只开正向服务端，reverse=只连反向地址，both=两者'),
  wsPort: Schema.number()
    .step(1)
    .min(0)
    .max(65535)
    .default(7791)
    .volatile()
    .description('正向 WS 监听端口（0 表示随机端口）'),
  wsPath: Schema.string()
    .default('/ws')
    .volatile()
    .description('正向 WS 路径'),
  accessToken: Schema.string()
    .default('')
    .role('secret')
    .volatile()
    .description('OneBot 鉴权令牌；留空表示不鉴权（仅限本机）'),
  reverseUrls: Schema.array(Schema.string())
    .default([])
    .volatile()
    .description('反向 WS 下游地址列表，例如 ws://127.0.0.1:6700'),
});

const TakeoverSchema = Schema.object({
  appId: Schema.string()
    .default('')
    .description('只接管该 AppID 的 QQBot；留空接管第一个出现的实例'),
  autoAckInteraction: Schema.boolean()
    .default(false)
    .description('由 noa 自动 ACK INTERACTION_CREATE；默认交给 dsh-qqbot'),
  isolation: Schema.union(['auto', 'always', 'off'])
    .default('auto')
    .volatile()
    .description('回复隔离：auto=有 OneBot 客户端在线时暂停 dsh；always=始终暂停 dsh；off=不隔离'),
  retryDelayMs: Schema.number()
    .step(1)
    .min(0)
    .default(30000)
    .description('桥启动失败后的重试间隔（毫秒）'),
});

const DshChatSchema = Schema.object({
  enable: Schema.boolean()
    .default(false)
    .volatile()
    .description('允许 OneBot 客户端通过 noa_dsh_chat 调用 dsh 内的 AI'),
  restrictTools: Schema.boolean()
    .default(true)
    .volatile()
    .description('仅对话回复：拒绝 AI 的一切读/写/改与命令工具调用；关闭后 AI 拥有完整工具权限'),
  timeoutMs: Schema.number()
    .step(1)
    .min(1000)
    .max(600000)
    .default(120000)
    .description('单次 AI 调用超时（毫秒）'),
  sessionIdleMs: Schema.number()
    .step(1)
    .min(0)
    .default(1800000)
    .description('对话 agent 闲置回收时间（毫秒）；0 表示每轮结束立即回收'),
  cwd: Schema.string()
    .default('')
    .description('agent 工作目录；留空使用 dsh 进程当前目录'),
});

export const Config = Schema.object({
  onebot: OneBotSchema,
  takeover: TakeoverSchema,
  dshChat: DshChatSchema,
});
