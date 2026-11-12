import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import { interactionToNoaEvent } from '../src/noa/events.js';

function tempMapper(): IdMapper {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-events-'));
  return new IdMapper({ file: path.join(dir, 'idmap.json') });
}

describe('interactionToNoaEvent', () => {
  it('maps a group button interaction into notice/noa_interaction', () => {
    const mapper = tempMapper();
    const event = interactionToNoaEvent(
      {
        id: '1b13d569-4610-4ab9-bc51-feecc5def6d4',
        type: 11,
        timestamp: '2026-07-20T21:53:54+08:00',
        chat_type: 1,
        group_openid: 'GROUP_A',
        group_member_openid: 'USER_A',
        data: {
          type: 11,
          resolved: {
            button_id: 'btn_signin',
            button_data: '/签到',
            message_id: 'RAW_MSG_1',
          },
        },
      },
      { mapper, idMode: 'mapped', selfOpenid: 'BOT', interactionRaw: false, now: () => 0 },
    );

    expect(event).toMatchObject({
      time: Math.floor(Date.parse('2026-07-20T21:53:54+08:00') / 1000),
      self_id: Number(mapper.selfPseudo('BOT')),
      post_type: 'notice',
      notice_type: 'noa_interaction',
      interaction_id: '1b13d569-4610-4ab9-bc51-feecc5def6d4',
      interaction_type: 11,
      scene: 'group',
      chat_type: 1,
      group_id: Number(mapper.pseudoOf('GROUP_A')),
      user_id: Number(mapper.pseudoOf('USER_A')),
      member_openid: 'USER_A',
      message_id: Number(mapper.pseudoMsgOf('RAW_MSG_1')),
      button_id: 'btn_signin',
      button_data: '/签到',
    });
    expect(event).not.toHaveProperty('raw');
  });

  it('maps c2c interactions, includes raw only when enabled, and derives scene from chat_type', () => {
    const mapper = tempMapper();
    const data = {
      id: 'i_2',
      type: 13,
      chat_type: 2,
      user_openid: 'USER_B',
      data: { type: 13, resolved: { feedback_opt: 'LIKE', checked: 1 } },
    };
    const bare = interactionToNoaEvent(data, {
      mapper, idMode: 'mapped', selfOpenid: 'BOT', interactionRaw: false, now: () => 1_700_000_000_000,
    });
    expect(bare).toMatchObject({ scene: 'c2c', chat_type: 2, feedback_opt: 'LIKE', checked: 1 });
    expect(bare).not.toHaveProperty('group_id');

    const withRaw = interactionToNoaEvent(data, {
      mapper, idMode: 'mapped', selfOpenid: 'BOT', interactionRaw: true, now: () => 1_700_000_000_000,
    });
    expect(withRaw?.raw).toEqual(data);
  });

  it('returns null when the interaction id is missing', () => {
    const mapper = tempMapper();
    expect(
      interactionToNoaEvent({ type: 11 }, {
        mapper, idMode: 'mapped', selfOpenid: 'BOT', interactionRaw: false, now: () => 0,
      }),
    ).toBeNull();
  });
});
