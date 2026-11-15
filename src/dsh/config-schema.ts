/**
 * dsh 设置页使用的插件 Config schema。
 *
 * dsh 只把声明了 `.volatile()` 的字段投影到设置表单；普通字段仍通过
 * profile 的 cordis.patch.yml 编辑。这里暴露 OneBot WS 的开关、模式、
 * 端口、路径、令牌、反向地址，以及 dsh AI 对话的启用/限制开关。
 *
 * schema 未声明的普通配置键（idMode、takeover、noa 等）由
 * schemastery 原样保留，继续走既有 normalizePluginConfig 合并逻辑。
 */

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
  dshChat: DshChatSchema,
});
