/**
 * dsh 设置页使用的插件 Config schema。
 *
 * dsh 只把声明了 `.volatile()` 的字段投影到设置表单；普通字段仍通过
 * profile 的 cordis.patch.yml 编辑。这里只暴露 OneBot WS 的开关、模式、
 * 端口、路径、令牌与反向地址，保存后由插件热重建 OneBot 服务。
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

export const Config = Schema.object({
  onebot: OneBotSchema,
});
