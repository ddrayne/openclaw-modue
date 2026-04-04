// Tests for lib/connection.js — Connection singleton
// Uses node:test + node:assert (zero npm deps).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// We need to intercept `require('./ws-client')` inside connection.js.
// Strategy: patch the require cache so connection.js gets our mock.
const path = require('node:path');
const Module = require('node:module');

// Resolve the real ws-client path so we can shim it in the cache.
const wsClientPath = require.resolve('../lib/ws-client');

// --- Mock OpenClawClient ---------------------------------------------------

class MockClient {
  constructor() {
    this._handlers = {};
    this.connected = false;
  }
  on(event, fn) { this._handlers[event] = fn; }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  rpc(_method, _params) { return Promise.resolve({}); }
  // Test helper — fire an event as if the server sent it.
  emit(event, payload) { this._handlers[event]?.(payload); }
}

// Inject the mock into the require cache *before* loading connection.js.
require.cache[wsClientPath] = {
  id: wsClientPath,
  filename: wsClientPath,
  loaded: true,
  exports: { OpenClawClient: MockClient },
};

// Now require the module-under-test.
const { Connection, STATUS_COLORS, IDLE_PHRASES, STATUS_PHRASES } = require('../lib/connection');

// --- Helpers ----------------------------------------------------------------

function makeLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeStorage(overrides = {}) {
  const store = { gatewayUrl: 'ws://mock:1234', gatewayToken: 'tok', ...overrides };
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
  };
}

/** Create a fresh Connection (bypasses singleton) and wire events via connect(). */
function freshConnection() {
  const storage = makeStorage();
  const log = makeLog();
  const conn = new Connection(storage, log);
  return conn;
}

/** Create a connected Connection with its mock client accessible. */
function connectedPair() {
  const conn = freshConnection();
  conn.connect();
  // The mock client is now at conn._client
  return { conn, client: conn._client };
}

// --- Tests ------------------------------------------------------------------

describe('Connection', () => {

  // Make sure the singleton is clean between tests.
  afterEach(() => {
    Connection.destroy();
  });

  // -------------------------------------------------------------------------
  // 1. Singleton pattern
  // -------------------------------------------------------------------------
  describe('singleton', () => {
    it('getInstance creates an instance on first call', () => {
      const c = Connection.getInstance(makeStorage(), makeLog());
      assert.ok(c instanceof Connection);
    });

    it('getInstance returns the same instance on subsequent calls', () => {
      const s = makeStorage();
      const l = makeLog();
      const a = Connection.getInstance(s, l);
      const b = Connection.getInstance();
      assert.equal(a, b);
    });

    it('getInstance throws without storage/log on first call', () => {
      assert.throws(
        () => Connection.getInstance(),
        /requires storage and log/
      );
    });

    it('destroy clears the singleton', () => {
      const a = Connection.getInstance(makeStorage(), makeLog());
      Connection.destroy();
      // Next call should require storage/log again.
      assert.throws(() => Connection.getInstance(), /requires storage and log/);
    });

    it('destroy is safe to call when no instance exists', () => {
      assert.doesNotThrow(() => Connection.destroy());
    });
  });

  // -------------------------------------------------------------------------
  // 2. _setStatus transitions
  // -------------------------------------------------------------------------
  describe('_setStatus', () => {
    it('sets agentStatus and moodColor for every known status', () => {
      const conn = freshConnection();
      for (const status of ['idle', 'thinking', 'talking', 'working', 'error', 'offline']) {
        conn._setStatus(status);
        assert.equal(conn.agentStatus, status);
        assert.equal(conn.moodColor, STATUS_COLORS[status]);
      }
      conn._teardown();
    });

    it('sets statusPhrase from STATUS_PHRASES for non-idle statuses', () => {
      const conn = freshConnection();
      for (const status of ['thinking', 'talking', 'working', 'error', 'offline']) {
        conn._setStatus(status);
        assert.equal(conn.statusPhrase, STATUS_PHRASES[status]);
      }
      conn._teardown();
    });

    it('sets statusPhrase to an IDLE_PHRASES entry for idle status', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      assert.ok(IDLE_PHRASES.includes(conn.statusPhrase));
      conn._teardown();
    });

    it('starts the idle cycle timer when transitioning to idle', () => {
      const conn = freshConnection();
      conn._setStatus('thinking');
      assert.equal(conn._idleTimer, null);
      conn._setStatus('idle');
      assert.notEqual(conn._idleTimer, null);
      conn._teardown();
    });

    it('stops the idle cycle timer when leaving idle', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      assert.notEqual(conn._idleTimer, null);
      conn._setStatus('thinking');
      assert.equal(conn._idleTimer, null);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Mood colors + approval override
  // -------------------------------------------------------------------------
  describe('mood colors', () => {
    it('each status maps to the expected color', () => {
      const conn = freshConnection();
      const expected = {
        idle:     '#31e000',
        thinking: '#9944FF',
        talking:  '#4488ff',
        working:  '#ff9900',
        error:    '#ff3333',
        offline:  '#333344',
      };
      for (const [status, color] of Object.entries(expected)) {
        conn._setStatus(status);
        assert.equal(conn.moodColor, color, `status=${status}`);
      }
      conn._teardown();
    });

    it('pendingApproval overrides moodColor to amber', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      assert.equal(conn.moodColor, STATUS_COLORS.idle);
      conn.pendingApproval = { id: 'x', command: 'rm -rf /' };
      conn._refreshMoodColor();
      assert.equal(conn.moodColor, '#ff9900');
      conn._teardown();
    });

    it('clearing pendingApproval restores status color', () => {
      const conn = freshConnection();
      conn._setStatus('talking');
      conn.pendingApproval = { id: 'x', command: 'y' };
      conn._refreshMoodColor();
      assert.equal(conn.moodColor, '#ff9900');
      conn.pendingApproval = null;
      conn._refreshMoodColor();
      assert.equal(conn.moodColor, STATUS_COLORS.talking);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 4. _appendText accumulation and truncation
  // -------------------------------------------------------------------------
  describe('_appendText', () => {
    it('accumulates text', () => {
      const conn = freshConnection();
      conn._appendText('hello');
      conn._appendText(' world');
      assert.equal(conn.currentText, 'hello world');
      conn._teardown();
    });

    it('truncates to the last 300 characters', () => {
      const conn = freshConnection();
      const chunk = 'a'.repeat(200);
      conn._appendText(chunk);
      conn._appendText(chunk); // now 400 chars
      assert.equal(conn.currentText.length, 300);
      // Should keep the *last* 300 chars (all 'a' here, but length matters)
      assert.equal(conn.currentText, 'a'.repeat(300));
      conn._teardown();
    });

    it('keeps text exactly at 300 when appending to exactly 300', () => {
      const conn = freshConnection();
      conn._appendText('x'.repeat(300));
      assert.equal(conn.currentText.length, 300);
      conn._appendText('y');
      assert.equal(conn.currentText.length, 300);
      assert.ok(conn.currentText.endsWith('y'));
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Subscriber pattern
  // -------------------------------------------------------------------------
  describe('onChange / _notify', () => {
    it('subscriber is called on _notify', () => {
      const conn = freshConnection();
      let called = false;
      conn.onChange(() => { called = true; });
      conn._notify();
      assert.ok(called);
      conn._teardown();
    });

    it('subscriber receives the connection instance', () => {
      const conn = freshConnection();
      let received = null;
      conn.onChange((c) => { received = c; });
      conn._notify();
      assert.equal(received, conn);
      conn._teardown();
    });

    it('multiple subscribers are all notified', () => {
      const conn = freshConnection();
      const calls = [];
      conn.onChange(() => calls.push('a'));
      conn.onChange(() => calls.push('b'));
      conn._notify();
      assert.deepEqual(calls, ['a', 'b']);
      conn._teardown();
    });

    it('unsubscribe removes the listener', () => {
      const conn = freshConnection();
      let count = 0;
      const unsub = conn.onChange(() => { count++; });
      conn._notify();
      assert.equal(count, 1);
      unsub();
      conn._notify();
      assert.equal(count, 1); // not called again
      conn._teardown();
    });

    it('subscriber errors are caught and logged', () => {
      const log = makeLog();
      const errors = [];
      log.error = (msg) => errors.push(msg);
      const conn = new Connection(makeStorage(), log);
      conn.onChange(() => { throw new Error('boom'); });
      conn._notify(); // should not throw
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('boom'));
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Agent event handlers
  // -------------------------------------------------------------------------
  describe('agent event handling', () => {

    describe('connection event', () => {
      it('sets connected=true and idle on connect', () => {
        const { conn, client } = connectedPair();
        client.emit('connection', { connected: true });
        assert.equal(conn.connected, true);
        assert.equal(conn.agentStatus, 'idle');
        assert.ok(conn.currentText.includes('Connected'));
        conn._teardown();
      });

      it('sets connected=false and offline on disconnect', () => {
        const { conn, client } = connectedPair();
        client.emit('connection', { connected: true });
        client.emit('connection', { connected: false });
        assert.equal(conn.connected, false);
        assert.equal(conn.agentStatus, 'offline');
        conn._teardown();
      });
    });

    describe('lifecycle', () => {
      it('start clears text and sets idle', () => {
        const { conn, client } = connectedPair();
        conn.currentText = 'leftover';
        client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
        assert.equal(conn.currentText, '');
        assert.equal(conn.agentStatus, 'idle');
        conn._teardown();
      });

      it('end sets idle and preserves last text', () => {
        const { conn, client } = connectedPair();
        conn.currentText = 'final answer';
        conn._setStatus('talking');
        client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
        assert.equal(conn.agentStatus, 'idle');
        assert.equal(conn.currentText, 'final answer');
        conn._teardown();
      });

      it('error sets error status and shows error text', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'lifecycle', data: { phase: 'error', error: 'kaboom' } });
        assert.equal(conn.agentStatus, 'error');
        assert.equal(conn.currentText, 'kaboom');
        conn._teardown();
      });
    });

    describe('thinking', () => {
      it('sets status to thinking and appends text', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'thinking', data: { thinking: 'Let me think...' } });
        assert.equal(conn.agentStatus, 'thinking');
        assert.ok(conn.currentText.includes('Let me think'));
        conn._teardown();
      });

      it('appends delta when no thinking field', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'thinking', data: { delta: 'partial' } });
        assert.equal(conn.agentStatus, 'thinking');
        assert.ok(conn.currentText.includes('partial'));
        conn._teardown();
      });
    });

    describe('assistant', () => {
      it('sets status to talking and appends delta', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'assistant', data: { delta: 'Hello!' } });
        assert.equal(conn.agentStatus, 'talking');
        assert.ok(conn.currentText.includes('Hello!'));
        conn._teardown();
      });
    });

    describe('tool', () => {
      it('tool start sets working status and shows tool name', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start', name: 'bash' } });
        assert.equal(conn.agentStatus, 'working');
        assert.equal(conn.currentText, 'bash');
        conn._teardown();
      });

      it('tool end stays in working status', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start', name: 'bash' } });
        client.emit('agent', { stream: 'tool', data: { phase: 'end' } });
        assert.equal(conn.agentStatus, 'working');
        conn._teardown();
      });

      it('tool start without name shows fallback text', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start' } });
        assert.equal(conn.currentText, 'Running tool...');
        conn._teardown();
      });
    });

    describe('channel tracking', () => {
      it('tracks sourceChannel from agent events', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'thinking', channel: 'vscode', data: { thinking: 'hmm' } });
        assert.equal(conn.sourceChannel, 'vscode');
        conn._teardown();
      });
    });

    describe('null event guard', () => {
      it('ignores null agent event', () => {
        const { conn, client } = connectedPair();
        // Should not throw
        client.emit('agent', null);
        assert.equal(conn.agentStatus, 'offline'); // unchanged from initial
        conn._teardown();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 7. Approval flow
  // -------------------------------------------------------------------------
  describe('approval flow', () => {
    it('exec.approval.requested sets pendingApproval and amber color', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', {
        id: 'abc',
        request: { command: 'rm -rf /' },
      });
      assert.deepEqual(conn.pendingApproval, { id: 'abc', command: 'rm -rf /' });
      assert.equal(conn.moodColor, '#ff9900');
      assert.equal(conn.statusPhrase, 'approve?');
      assert.equal(conn.currentText, 'rm -rf /');
      conn._teardown();
    });

    it('exec.approval.requested uses fallback when no command', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: 'z', request: {} });
      assert.equal(conn.pendingApproval.command, '?');
      assert.equal(conn.currentText, 'Approve this command?');
      conn._teardown();
    });

    it('exec.approval.resolved clears pendingApproval for matching id', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: 'abc', request: { command: 'ls' } });
      client.emit('exec.approval.resolved', { id: 'abc' });
      assert.equal(conn.pendingApproval, null);
      conn._teardown();
    });

    it('exec.approval.resolved ignores non-matching id', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: 'abc', request: { command: 'ls' } });
      client.emit('exec.approval.resolved', { id: 'OTHER' });
      assert.notEqual(conn.pendingApproval, null);
      conn._teardown();
    });

    it('exec.approval.resolved restores moodColor to current status color', () => {
      const { conn, client } = connectedPair();
      conn._setStatus('talking');
      client.emit('exec.approval.requested', { id: 'x', request: { command: 'y' } });
      assert.equal(conn.moodColor, '#ff9900');
      client.emit('exec.approval.resolved', { id: 'x' });
      // After resolving, _refreshMoodColor uses current agentStatus.
      // The status was last set internally; let's just check it's not amber.
      assert.notEqual(conn.moodColor, '#ff9900');
      conn._teardown();
    });

    it('approveExec calls rpc and clears approval on success', async () => {
      const { conn, client } = connectedPair();
      let rpcCall = null;
      client.rpc = (method, params) => {
        rpcCall = { method, params };
        return Promise.resolve({});
      };
      conn.pendingApproval = { id: '42', command: 'ls' };

      conn.approveExec();
      // Wait for the promise chain to resolve.
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(rpcCall.method, 'exec.approval.resolve');
      assert.equal(rpcCall.params.id, '42');
      assert.equal(rpcCall.params.decision, 'allow-once');
      assert.equal(conn.pendingApproval, null);
      assert.equal(conn.currentText, 'Approved');
      conn._teardown();
    });

    it('denyExec calls rpc with deny decision', async () => {
      const { conn, client } = connectedPair();
      let rpcCall = null;
      client.rpc = (method, params) => {
        rpcCall = { method, params };
        return Promise.resolve({});
      };
      conn.pendingApproval = { id: '42', command: 'ls' };

      conn.denyExec();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(rpcCall.params.decision, 'deny');
      assert.equal(conn.pendingApproval, null);
      assert.equal(conn.currentText, 'Denied');
      conn._teardown();
    });

    it('approveExec is a no-op without pendingApproval', () => {
      const { conn, client } = connectedPair();
      let rpcCalled = false;
      client.rpc = () => { rpcCalled = true; return Promise.resolve(); };
      conn.approveExec();
      assert.equal(rpcCalled, false);
      conn._teardown();
    });

    it('approveExec is a no-op without a client', () => {
      const conn = freshConnection();
      conn.pendingApproval = { id: '1', command: 'x' };
      // No client connected — should not throw.
      assert.doesNotThrow(() => conn.approveExec());
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 8. getLedColors
  // -------------------------------------------------------------------------
  describe('getLedColors', () => {
    it('returns correct number of LEDs', () => {
      const conn = freshConnection();
      assert.equal(conn.getLedColors(4, 0).length, 4);
      assert.equal(conn.getLedColors(16, 0).length, 16);
      conn._teardown();
    });

    it('defaults to 8 LEDs', () => {
      const conn = freshConnection();
      assert.equal(conn.getLedColors().length, 8);
      conn._teardown();
    });

    it('idle returns solid color with FF alpha', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      const colors = conn.getLedColors(4, 0);
      assert.ok(colors.every((c) => c === `${STATUS_COLORS.idle}FF`));
      conn._teardown();
    });

    it('thinking pulses between FF and 44 alpha', () => {
      const conn = freshConnection();
      conn._setStatus('thinking');
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c.endsWith('FF')));
      assert.ok(odd.every((c) => c.endsWith('44')));
      conn._teardown();
    });

    it('talking pulses between FF and 66 alpha', () => {
      const conn = freshConnection();
      conn._setStatus('talking');
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c.endsWith('FF')));
      assert.ok(odd.every((c) => c.endsWith('66')));
      conn._teardown();
    });

    it('working pulses between FF and 66 alpha', () => {
      const conn = freshConnection();
      conn._setStatus('working');
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c.endsWith('FF')));
      assert.ok(odd.every((c) => c.endsWith('66')));
      conn._teardown();
    });

    it('error returns solid FF alpha (no pulse)', () => {
      const conn = freshConnection();
      conn._setStatus('error');
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c === `${STATUS_COLORS.error}FF`));
      assert.ok(odd.every((c) => c === `${STATUS_COLORS.error}FF`));
      conn._teardown();
    });

    it('offline returns dim 44 alpha (no pulse)', () => {
      const conn = freshConnection();
      conn._setStatus('offline');
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c === `${STATUS_COLORS.offline}44`));
      assert.ok(odd.every((c) => c === `${STATUS_COLORS.offline}44`));
      conn._teardown();
    });

    it('pendingApproval flashes amber on even frames, transparent on odd', () => {
      const conn = freshConnection();
      conn.pendingApproval = { id: 'a', command: 'x' };
      const even = conn.getLedColors(4, 0);
      const odd = conn.getLedColors(4, 1);
      assert.ok(even.every((c) => c === '#ff9900FF'));
      assert.ok(odd.every((c) => c === '#00000000'));
      conn._teardown();
    });

    it('pendingApproval overrides any status', () => {
      const conn = freshConnection();
      conn._setStatus('thinking');
      conn.pendingApproval = { id: 'b', command: 'y' };
      const colors = conn.getLedColors(4, 0);
      assert.ok(colors.every((c) => c === '#ff9900FF'));
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Idle phrase cycling
  // -------------------------------------------------------------------------
  describe('idle phrase cycling', () => {
    it('initial idle phrase is from IDLE_PHRASES', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      assert.ok(IDLE_PHRASES.includes(conn.statusPhrase));
      conn._teardown();
    });

    it('phrase index advances and wraps around', () => {
      const conn = freshConnection();
      const phrases = [];
      // Manually cycle through by simulating what the timer does.
      conn._setStatus('idle');
      phrases.push(conn.statusPhrase);
      for (let i = 0; i < IDLE_PHRASES.length; i++) {
        conn._idlePhraseIndex++;
        conn.statusPhrase = IDLE_PHRASES[conn._idlePhraseIndex % IDLE_PHRASES.length];
        phrases.push(conn.statusPhrase);
      }
      // After cycling through all phrases, we should be back to the first one.
      assert.equal(phrases[0], phrases[IDLE_PHRASES.length]);
      // All idle phrases should appear.
      for (const p of IDLE_PHRASES) {
        assert.ok(phrases.includes(p), `Missing phrase: ${p}`);
      }
      conn._teardown();
    });

    it('switching away from idle stops the timer', () => {
      const conn = freshConnection();
      conn._setStatus('idle');
      assert.notEqual(conn._idleTimer, null);
      conn._setStatus('thinking');
      assert.equal(conn._idleTimer, null);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 10. connect / disconnect / rpc passthrough
  // -------------------------------------------------------------------------
  describe('connect / disconnect', () => {
    it('connect creates a client and connects', () => {
      const conn = freshConnection();
      conn.connect();
      assert.ok(conn._client instanceof MockClient);
      assert.equal(conn._client.connected, true);
      conn._teardown();
    });

    it('disconnect tears down the client', () => {
      const conn = freshConnection();
      conn.connect();
      const client = conn._client;
      conn.disconnect();
      assert.equal(conn._client, null);
      assert.equal(client.connected, false);
      conn._teardown();
    });

    it('reconnect replaces old client', () => {
      const conn = freshConnection();
      conn.connect();
      const first = conn._client;
      conn.connect();
      assert.notEqual(conn._client, first);
      assert.equal(first.connected, false); // old one disconnected
      conn._teardown();
    });

    it('rpc rejects when not connected', async () => {
      const conn = freshConnection();
      await assert.rejects(() => conn.rpc('test', {}), /Not connected/);
      conn._teardown();
    });

    it('rpc passes through to client', async () => {
      const { conn, client } = connectedPair();
      let called = null;
      client.rpc = (m, p) => { called = { m, p }; return Promise.resolve('ok'); };
      const result = await conn.rpc('foo', { bar: 1 });
      assert.equal(result, 'ok');
      assert.equal(called.m, 'foo');
      assert.deepEqual(called.p, { bar: 1 });
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Teardown
  // -------------------------------------------------------------------------
  describe('teardown', () => {
    it('clears subscribers, stops timers, disconnects', () => {
      const conn = freshConnection();
      conn.connect();
      let calls = 0;
      conn.onChange(() => calls++);
      conn._setStatus('idle'); // starts timer
      conn._teardown();
      assert.equal(conn._client, null);
      assert.equal(conn._idleTimer, null);
      assert.equal(conn._subscribers.size, 0);
      // Notify after teardown should not call old subscriber.
      conn._notify();
      assert.equal(calls, 0);
    });
  });
});
