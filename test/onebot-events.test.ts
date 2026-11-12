import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import { officialEventToOneBotEvent } from '../src/onebot/events.js';

function makeCtx() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-events-'));
  const mapper = new IdMapper({ file: path.join(dir, 'idmap.json') });
  const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    ctx: { mapper, idMode: 'mapped' as const, selfOpenid: 'BOT_OPENID', now: () => fixedNow },
    mapper,
    selfPseudo: mapper.selfPseudo('BOT_OPENID'),
  };
}

describe('officialEventToOneBotEvent', () => {
  it('maps GROUP_AT_MESSAGE_CREATE to a v11 group message with CQ at self', () => {
    const { ctx, mapper, selfPseudo } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_AT_MESSAGE_CREATE',
        data: {
          id: 'RAW_1',
          group_openid: 'GROUP_A',
          author: { user_openid: 'USER_B', username: 'Bob' },
          content: '<qqbot-at-user id="BOT_OPENID"/>hello',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
      ctx,
    );
    expect(event).not.toBeNull();
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message_type).toBe('group');
    expect(event.group_id).toBe(Number(mapper.pseudoOf('GROUP_A')));
    expect(event.user_id).toBe(Number(mapper.pseudoOf('USER_B')));
    expect(event.message[0]).toEqual({ type: 'at', data: { qq: selfPseudo } });
    expect(event.raw_message).toBe(`[CQ:at,qq=${selfPseudo}]hello`);
    expect(event.sender.nickname).toBe('Bob');
    expect(event.font).toBe(0);
    expect(event.anonymous).toBeNull();
  });

  it('maps C2C_MESSAGE_CREATE to a private friend message', () => {
    const { ctx, mapper } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'C2C_MESSAGE_CREATE',
        data: {
          id: 'RAW_2',
          author: { user_openid: 'USER_C', username: 'Carol' },
          content: 'hi',
          timestamp: '2026-01-01T00:01:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message_type).toBe('private');
    expect(event.sub_type).toBe('friend');
    expect(event.user_id).toBe(Number(mapper.pseudoOf('USER_C')));
    expect(event.group_id).toBeUndefined();
    expect(event.at_me).toBe(false);
    expect(event.to_me).toBe(true);
  });

  it('parses 2026 <@member_openid> markers and flags at_me', () => {
    const { ctx, selfPseudo } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MESSAGE_CREATE',
        data: {
          id: 'RAW_3',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: `<@BOT_OPENID> 帮我看看`,
          mentions: [{ id: 'BOT_OPENID', is_you: true }],
          timestamp: '2026-01-01T00:02:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message[0]).toEqual({ type: 'at', data: { qq: selfPseudo } });
    expect(event.raw_message).toContain(`[CQ:at,qq=${selfPseudo}]`);
    expect(event.at_me).toBe(true);
    expect(event.to_me).toBe(true);
  });

  it('restores the at-self segment when GROUP_AT_MESSAGE_CREATE content has its prefix stripped', () => {
    const { ctx, selfPseudo } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_AT_MESSAGE_CREATE',
        data: {
          id: 'RAW_4',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: 'hello',
          timestamp: '2026-01-01T00:03:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message).toEqual([
      { type: 'at', data: { qq: selfPseudo } },
      { type: 'text', data: { text: 'hello' } },
    ]);
    expect(event.at_me).toBe(true);
  });

  it('does not invent an at segment for ordinary full-mode group messages', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MESSAGE_CREATE',
        data: {
          id: 'RAW_5',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: '大家早上好',
          timestamp: '2026-01-01T00:04:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message).toEqual([{ type: 'text', data: { text: '大家早上好' } }]);
    expect(event.at_me).toBe(false);
    expect(event.to_me).toBe(false);
  });

  it('uses msg_elements content when the event body is blank (chat record / quote)', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MESSAGE_CREATE',
        data: {
          id: 'RAW_6',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: ' ',
          message_type: 103,
          msg_elements: [{ content: '=== 消息 1 ===\n今天的学习计划已完成' }],
          timestamp: '2026-01-01T00:05:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message).toEqual([
      { type: 'text', data: { text: '=== 消息 1 ===\n今天的学习计划已完成' } },
    ]);
  });

  it('degrades ark cards to text when there is no body content', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MESSAGE_CREATE',
        data: {
          id: 'RAW_7',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: '',
          message_type: 3,
          ark_data: { ark_name: '小程序', fields: { title: '点我看详情' } },
          timestamp: '2026-01-01T00:06:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message).toEqual([{ type: 'text', data: { text: '[卡片:点我看详情]' } }]);
  });

  it('maps at-all markers to CQ at qq=all', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MESSAGE_CREATE',
        data: {
          id: 'RAW_8',
          group_openid: 'GROUP_A',
          author: { member_openid: 'USER_B', username: 'Bob' },
          content: '<@all> 开会了',
          timestamp: '2026-01-01T00:07:00.000Z',
        },
      },
      ctx,
    );
    if (event === null || event.post_type !== 'message') throw new Error('期望 message 事件');
    expect(event.message[0]).toEqual({ type: 'at', data: { qq: 'all' } });
    expect(event.at_me).toBe(false);
  });

  it('maps GROUP_MEMBER_ADD / QUIT to group_increase / group_decrease', () => {
    const { ctx, mapper } = makeCtx();
    const added = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MEMBER_ADD',
        data: { group_openid: 'GROUP_A', user_openid: 'USER_D' },
      },
      ctx,
    );
    expect(added).toMatchObject({
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      group_id: Number(mapper.pseudoOf('GROUP_A')),
      user_id: Number(mapper.pseudoOf('USER_D')),
    });

    const quit = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_MEMBER_QUIT',
        data: { group_openid: 'GROUP_A', user_openid: 'USER_D' },
      },
      ctx,
    );
    expect(quit).toMatchObject({ notice_type: 'group_decrease', sub_type: 'leave' });
  });

  it('maps GROUP_ADD_ROBOT to group_increase with self as user_id', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      { eventType: 'GROUP_ADD_ROBOT', data: { group_openid: 'GROUP_A' } },
      ctx,
    );
    expect(event).toMatchObject({
      post_type: 'notice',
      notice_type: 'group_increase',
      user_id: Number(ctx.mapper.selfPseudo('BOT_OPENID')),
    });
  });

  it('maps GROUP_JOIN_REQUEST to a group request with opaque flag', () => {
    const { ctx } = makeCtx();
    const event = officialEventToOneBotEvent(
      {
        eventType: 'GROUP_JOIN_REQUEST',
        data: {
          group_openid: 'GROUP_A',
          user_openid: 'USER_E',
          comment: '让我进群',
          notification_seq: 42,
        },
      },
      ctx,
    );
    expect(event).toMatchObject({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      comment: '让我进群',
      flag: 'GROUP_A:42',
    });
  });

  it('maps FRIEND_ADD to friend_add notice', () => {
    const { ctx, mapper } = makeCtx();
    const event = officialEventToOneBotEvent(
      { eventType: 'FRIEND_ADD', data: { user_openid: 'USER_F' } },
      ctx,
    );
    expect(event).toMatchObject({
      post_type: 'notice',
      notice_type: 'friend_add',
      user_id: Number(mapper.pseudoOf('USER_F')),
    });
  });

  it('returns null for events without a v11 equivalent', () => {
    const { ctx } = makeCtx();
    expect(officialEventToOneBotEvent({ eventType: 'INPUT_NOTIFY', data: {} }, ctx)).toBeNull();
  });
});
