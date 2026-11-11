'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendOwnerAliveCard, LINK_URL, CREATOR_JID } = require('../lib/aliveCard.cjs');

const JID = '2348000000001@s.whatsapp.net';
const TEXT = 'Bright Emmanuel is ALIVE\n\nBy X\n\nFor external plugins commands\nVisit here https://levanter.site/plugin';
const realFetch = global.fetch;

function fakeSock(url, creatorUrl = null) {
  const sent = [];
  return {
    sent,
    profilePictureUrl: async (jid) => {
      const u = jid === JID ? url : creatorUrl;
      if (u instanceof Error) throw u;
      return u;
    },
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { ok: true }; },
  };
}

test('uses the owner profile picture as the link-card thumbnail and keeps the text/URL', async () => {
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer });
  try {
    const sock = fakeSock('https://pps.example/dp.jpg');
    await sendOwnerAliveCard(sock, JID, { text: TEXT });
    const c = sock.sent[0].content;
    assert.equal(sock.sent[0].jid, JID);
    assert.equal(c.text, TEXT);
    assert.ok(TEXT.includes(LINK_URL));
    const ad = c.contextInfo.externalAdReply;
    assert.ok(Buffer.isBuffer(ad.thumbnail));
    assert.equal(ad.thumbnail.length, 4);
    assert.equal(ad.sourceUrl, LINK_URL);
    assert.equal(ad.mediaType, 1);
  } finally { global.fetch = realFetch; }
});

test('no profile picture -> plain text fallback (old behaviour)', async () => {
  const sock = fakeSock(null);
  await sendOwnerAliveCard(sock, JID, { text: TEXT });
  assert.deepEqual(sock.sent[0].content, { text: TEXT });
});

test('picture lookup error -> plain text fallback, never throws', async () => {
  const sock = fakeSock(new Error('404 item-not-found'));
  await sendOwnerAliveCard(sock, JID, { text: TEXT });
  assert.deepEqual(sock.sent[0].content, { text: TEXT });
});

test('download failure -> plain text fallback', async () => {
  global.fetch = async () => ({ ok: false, status: 403 });
  try {
    const sock = fakeSock('https://pps.example/dp.jpg');
    await sendOwnerAliveCard(sock, JID, { text: TEXT });
    assert.deepEqual(sock.sent[0].content, { text: TEXT });
  } finally { global.fetch = realFetch; }
});

test('oversized picture is ignored', async () => {
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(3 * 1024 * 1024) });
  try {
    const sock = fakeSock('https://pps.example/dp.jpg');
    await sendOwnerAliveCard(sock, JID, { text: TEXT });
    assert.deepEqual(sock.sent[0].content, { text: TEXT });
  } finally { global.fetch = realFetch; }
});

test('owner has no picture -> creator picture is used', async () => {
  const fetched = [];
  global.fetch = async (url) => { fetched.push(url); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  try {
    const sock = fakeSock(null, 'https://pps.example/creator.jpg');
    await sendOwnerAliveCard(sock, JID, { text: TEXT });
    assert.deepEqual(fetched, ['https://pps.example/creator.jpg']);
    assert.ok(Buffer.isBuffer(sock.sent[0].content.contextInfo.externalAdReply.thumbnail));
    assert.equal(sock.sent[0].content.text, TEXT);
  } finally { global.fetch = realFetch; }
});

test('owner picture wins over creator picture', async () => {
  const fetched = [];
  global.fetch = async (url) => { fetched.push(url); return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }; };
  try {
    const sock = fakeSock('https://pps.example/owner.jpg', 'https://pps.example/creator.jpg');
    await sendOwnerAliveCard(sock, JID, { text: TEXT });
    assert.deepEqual(fetched, ['https://pps.example/owner.jpg']);
  } finally { global.fetch = realFetch; }
});

test('neither owner nor creator has a picture -> plain text', async () => {
  const sock = fakeSock(null, null);
  await sendOwnerAliveCard(sock, JID, { text: TEXT });
  assert.deepEqual(sock.sent[0].content, { text: TEXT });
});

test('creator constant matches the .creator card contact', () => {
  assert.equal(CREATOR_JID, '2349068551055@s.whatsapp.net');
});
