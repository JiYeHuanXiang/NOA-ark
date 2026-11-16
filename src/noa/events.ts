import type { IdMapper } from '../core/idmap.js';

export interface NoaInteractionContext {
  mapper: IdMapper;
  idMode: 'mapped' | 'passthrough';
  selfOpenid: string;

  interactionRaw: boolean;
  now: () => number;
}

const SCENE_BY_CHAT_TYPE: Record<number, string> = {
  0: 'guild',
  1: 'group',
  2: 'c2c',
};

export function interactionToNoaEvent(
  data: Record<string, unknown>,
  ctx: NoaInteractionContext,
): Record<string, unknown> | null {
  const interactionId = readString(data.id);
  if (interactionId === '') return null;

  const payload = isRecord(data.data) ? data.data : {};
  const resolved = isRecord(payload.resolved) ? payload.resolved : {};
  const interactionType = readNumber(data.type) || readNumber(payload.type);
  const chatType = readNumber(data.chat_type);
  const scene = readString(data.scene) || SCENE_BY_CHAT_TYPE[chatType] || '';
  const groupOpenid = readString(data.group_openid);
  const memberOpenid = readString(data.group_member_openid);
  const userOpenid = readString(data.user_openid);
  const operatorOpenid = memberOpenid !== '' ? memberOpenid : userOpenid;
  const messageId = readString(resolved.message_id, data.message_id);
  const authorizeData = isRecord(resolved.authorize_data) ? resolved.authorize_data : {};

  const event: Record<string, unknown> = {
    time: timeOf(data, ctx.now),
    self_id: exposeSelf(ctx),
    post_type: 'notice',
    notice_type: 'noa_interaction',
    interaction_id: interactionId,
    interaction_type: interactionType,
    scene,
    chat_type: chatType,
    user_id: operatorOpenid === '' ? 0 : expose(ctx, operatorOpenid),
    member_openid: memberOpenid,
    message_id: messageId === '' ? '' : exposeMessage(ctx, messageId),
    button_id: readString(resolved.button_id),
    button_data: readString(resolved.button_data),
    feature_id: readString(resolved.feature_id),
    feedback_opt: readString(resolved.feedback_opt),
    checked: readNumber(resolved.checked),
    action: readString(resolved.action),
    authorize_scope: readString(authorizeData.scope),
  };
  if (scene === 'group') {
    event.group_id = groupOpenid === '' ? 0 : expose(ctx, groupOpenid);
  }
  if (ctx.interactionRaw) event.raw = data;
  return event;
}

function expose(ctx: NoaInteractionContext, openid: string): number | string {
  if (ctx.idMode === 'passthrough') return openid;
  return Number(ctx.mapper.pseudoOf(openid));
}

function exposeMessage(ctx: NoaInteractionContext, rawMsgId: string): number | string {
  if (ctx.idMode === 'passthrough') return rawMsgId;
  return Number(ctx.mapper.pseudoMsgOf(rawMsgId));
}

function exposeSelf(ctx: NoaInteractionContext): number | string {
  if (ctx.idMode === 'passthrough') return ctx.selfOpenid;
  return Number(ctx.mapper.selfPseudo(ctx.selfOpenid));
}

function timeOf(data: Record<string, unknown>, now: () => number): number {
  const raw = readString(data.timestamp, data.time);
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(now() / 1000);
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
