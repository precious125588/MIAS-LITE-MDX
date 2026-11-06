'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionDigits, parseDiscardSessions, matchesSession, shouldPruneSession } = require('./sessionPolicy.cjs');

test('normalizes WhatsApp JIDs with device suffixes to digits', () => {
  assert.equal(sessionDigits('2348152433778:12@s.whatsapp.net'), '2348152433778');
});

test('parses explicit discard entries without substring matching', () => {
  const entries = parseDiscardSessions('+2349068551055, 1555');
  assert.equal(entries.has('2349068551055'), true);
  assert.equal(entries.has('234906855105'), false);
});

test('preserves exactly the authenticated environment session', () => {
  assert.equal(matchesSession('2348152433778@s.whatsapp.net', '2348152433778'), true);
  assert.equal(shouldPruneSession('2348152433778@s.whatsapp.net', '2348152433778'), false);
  assert.equal(shouldPruneSession('2349068551055@s.whatsapp.net', '2348152433778'), true);
});

test('explicit reset cannot prune the authenticated environment session', () => {
  assert.equal(shouldPruneSession('2348152433778@s.whatsapp.net', '2348152433778', new Set(), true), false);
  assert.equal(shouldPruneSession('2349068551055@s.whatsapp.net', '2348152433778', new Set(), true), true);
});

test('does not prune arbitrary session IDs based on digit substrings', () => {
  assert.equal(shouldPruneSession('session-2349068551055-backup', '', new Set(['2349068551055'])), false);
  assert.equal(shouldPruneSession('2349068551055@s.whatsapp.net', '', new Set(['2349068551055'])), true);
});
