// Tests for lib/ws-client.js — focused on disconnect() draining behavior.
// We don't stand up a real WebSocket; rpc() registers a pending entry even
// when the socket isn't connected (sendFrame is a no-op without a socket),
// which is exactly the surface we want to assert against.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { OpenClawClient } = require('../lib/ws-client');

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });
const makeStorage = () => ({ get: () => null, set: () => {} });

describe('OpenClawClient.disconnect', () => {
  it('rejects every pending RPC with "Disconnected"', async () => {
    const c = new OpenClawClient('ws://localhost:1', 'tok', makeLog(), makeStorage());
    const p1 = c.rpc('a', {});
    const p2 = c.rpc('b', {});
    assert.equal(c.pending.size, 2);

    // Set up rejection assertions BEFORE disconnect so we don't drop the
    // synchronous reject and trip an unhandledRejection.
    const expect1 = assert.rejects(p1, /Disconnected/);
    const expect2 = assert.rejects(p2, /Disconnected/);

    c.disconnect();
    assert.equal(c.pending.size, 0);

    await expect1;
    await expect2;
  });

  it('clears each pending entry timeout (no lingering timers)', async () => {
    const c = new OpenClawClient('ws://localhost:1', 'tok', makeLog(), makeStorage());
    const p = c.rpc('a', {});
    const entry = [...c.pending.values()][0];
    const timeout = entry.timeout;
    // timeouts have an internal hasRef in Node; before disconnect, ref is held.
    assert.ok(timeout);

    const expectReject = assert.rejects(p, /Disconnected/);
    c.disconnect();
    await expectReject;

    // After disconnect, the timer was cleared (callback would otherwise fire
    // ~15s later and try to delete from an empty Map). We can verify
    // _idleTimeout property is null on the cleared timer.
    assert.equal(timeout._idleTimeout, -1);
  });

  it('is safe to call when there are no pending RPCs', () => {
    const c = new OpenClawClient('ws://localhost:1', 'tok', makeLog(), makeStorage());
    assert.doesNotThrow(() => c.disconnect());
    assert.equal(c.pending.size, 0);
  });

  it('is safe to call multiple times', async () => {
    const c = new OpenClawClient('ws://localhost:1', 'tok', makeLog(), makeStorage());
    const p = c.rpc('a', {});
    const expectReject = assert.rejects(p, /Disconnected/);
    c.disconnect();
    assert.doesNotThrow(() => c.disconnect());
    await expectReject;
  });
});
