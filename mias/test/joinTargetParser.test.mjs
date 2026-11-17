import test from 'node:test';
import assert from 'node:assert/strict';
import parser from '../lib/joinTargetParser.cjs';

const { parseJoinTarget } = parser;

test('group invite links resolve to the group code', () => {
  assert.deepEqual(parseJoinTarget('https://chat.whatsapp.com/AbCdEfGhIjKlMn'), { kind: 'group', code: 'AbCdEfGhIjKlMn' });
  assert.deepEqual(parseJoinTarget('chat.whatsapp.com/AbCdEfGhIjKlMn?mode=ac_t'), { kind: 'group', code: 'AbCdEfGhIjKlMn' });
});

test('channel links resolve to the channel code, with or without a post id', () => {
  assert.deepEqual(parseJoinTarget('https://whatsapp.com/channel/0029VaXxxxAbCdEf'), { kind: 'channel', code: '0029VaXxxxAbCdEf' });
  assert.deepEqual(parseJoinTarget('https://www.whatsapp.com/channel/0029VaXxxxAbCdEf/123'), { kind: 'channel', code: '0029VaXxxxAbCdEf' });
});

test('a bare code is treated as a group code', () => {
  assert.deepEqual(parseJoinTarget('AbCdEfGhIjKlMn'), { kind: 'group', code: 'AbCdEfGhIjKlMn' });
});

test('links from other sites and garbage are rejected instead of sent as a group code', () => {
  for (const input of ['https://whatsapp.com/', 'https://example.com/channel/0029VaXxxxAbCdEf', 'hello there', 'https://chat.whatsapp.com/short', '']) {
    assert.equal(parseJoinTarget(input).kind, 'invalid', input);
  }
});
