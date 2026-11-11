import test from "node:test";
import assert from "node:assert/strict";
import { throttleGroupFetch, GROUP_FETCH_TTL_MS } from "../lib/groupFetchThrottle.mjs";

const GROUPS = { "1@g.us": { id: "1@g.us", participants: [{ id: "a@s.whatsapp.net" }] } };

function fakeSock(respond) {
  const sock = { calls: 0 };
  sock.groupFetchAllParticipating = async () => {
    sock.calls++;
    return respond(sock.calls);
  };
  return sock;
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("concurrent callers share one request", async () => {
  const sock = fakeSock(() => GROUPS);
  throttleGroupFetch(sock, { now: clock().now });
  const [a, b, c] = await Promise.all([
    sock.groupFetchAllParticipating(),
    sock.groupFetchAllParticipating(),
    sock.groupFetchAllParticipating(),
  ]);
  assert.equal(sock.calls, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("reuses the result within the TTL and refetches after it", async () => {
  const sock = fakeSock(() => GROUPS);
  const t = clock();
  throttleGroupFetch(sock, { now: t.now });
  await sock.groupFetchAllParticipating();
  t.advance(5 * 60 * 1000);
  await sock.groupFetchAllParticipating();
  assert.equal(sock.calls, 1, "still inside TTL");
  t.advance(GROUP_FETCH_TTL_MS);
  await sock.groupFetchAllParticipating();
  assert.equal(sock.calls, 2, "TTL passed, fetch again");
});

test("empty results are not cached", async () => {
  const sock = fakeSock((n) => (n === 1 ? {} : GROUPS));
  throttleGroupFetch(sock, { now: clock().now });
  assert.deepEqual(await sock.groupFetchAllParticipating(), {});
  assert.deepEqual(await sock.groupFetchAllParticipating(), GROUPS);
  assert.equal(sock.calls, 2);
});

test("failures reach the caller and are not cached", async () => {
  const sock = fakeSock((n) => {
    if (n === 1) throw new Error("ws closed");
    return GROUPS;
  });
  throttleGroupFetch(sock, { now: clock().now });
  await assert.rejects(sock.groupFetchAllParticipating(), /ws closed/);
  assert.deepEqual(await sock.groupFetchAllParticipating(), GROUPS);
  assert.equal(sock.calls, 2);
});

test("wrapping twice is a no-op and a socket without the method is skipped", async () => {
  const sock = fakeSock(() => GROUPS);
  const t = clock();
  assert.equal(throttleGroupFetch(sock, { now: t.now }), true);
  assert.equal(throttleGroupFetch(sock, { now: t.now }), false);
  await sock.groupFetchAllParticipating();
  await sock.groupFetchAllParticipating();
  assert.equal(sock.calls, 1);
  assert.equal(throttleGroupFetch({}, {}), false);
  assert.equal(throttleGroupFetch(null, {}), false);
});
