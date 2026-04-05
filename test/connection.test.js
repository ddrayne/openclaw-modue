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

    it('truncates to the last MAX_TEXT_LENGTH characters', () => {
      const conn = freshConnection();
      const chunk = 'a'.repeat(500);
      conn._appendText(chunk);
      conn._appendText(chunk); // now 1000 chars
      assert.equal(conn.currentText.length, 800);
      assert.equal(conn.currentText, 'a'.repeat(800));
      conn._teardown();
    });

    it('keeps text at MAX_TEXT_LENGTH when appending beyond limit', () => {
      const conn = freshConnection();
      conn._appendText('x'.repeat(800));
      assert.equal(conn.currentText.length, 800);
      conn._appendText('y');
      assert.equal(conn.currentText.length, 800);
      assert.ok(conn.currentText.endsWith('y'));
      conn._teardown();
    });

    it('also sets displayText via _extractDisplayText', () => {
      const conn = freshConnection();
      conn._appendText('Hello world');
      assert.equal(conn.displayText, 'Hello world');
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
      it('start clears text and sets thinking', () => {
        const { conn, client } = connectedPair();
        conn.currentText = 'leftover';
        client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
        assert.equal(conn.currentText, '');
        assert.equal(conn.displayText, '');
        assert.equal(conn.agentStatus, 'thinking');
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

      it('error sets error status and shows error in displayText', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'lifecycle', data: { phase: 'error', error: 'kaboom' } });
        assert.equal(conn.agentStatus, 'error');
        assert.equal(conn.displayText, 'kaboom');
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
      it('tool start sets working status and shows tool name in displayText', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start', name: 'web_search' } });
        assert.equal(conn.agentStatus, 'working');
        assert.equal(conn.displayText, '\u2699 web_search');
        conn._teardown();
      });

      it('tool end stays in working status', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start', name: 'bash' } });
        client.emit('agent', { stream: 'tool', data: { phase: 'end' } });
        assert.equal(conn.agentStatus, 'working');
        conn._teardown();
      });

      it('tool start without name shows fallback text in displayText', () => {
        const { conn, client } = connectedPair();
        client.emit('agent', { stream: 'tool', data: { phase: 'start' } });
        assert.equal(conn.displayText, 'running tool...');
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
    it('exec.approval.requested sets pendingApproval with risk and amber color', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', {
        id: 'abc',
        request: { command: 'rm -r /tmp' },
      });
      assert.deepEqual(conn.pendingApproval, { id: 'abc', command: 'rm -r /tmp', risk: 'HIGH' });
      assert.equal(conn.moodColor, '#ff9900');
      assert.equal(conn.statusPhrase, '\u26A0 APPROVE?');
      assert.equal(conn.displayText, 'rm -r /tmp');
      conn._teardown();
    });

    it('exec.approval.requested non-destructive gets low risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', {
        id: 'abc',
        request: { command: 'ls -la' },
      });
      assert.deepEqual(conn.pendingApproval, { id: 'abc', command: 'ls -la', risk: 'low' });
      assert.equal(conn.statusPhrase, 'approve?');
      assert.equal(conn.displayText, 'ls -la');
      conn._teardown();
    });

    it('exec.approval.requested uses fallback when no command', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: 'z', request: {} });
      assert.equal(conn.pendingApproval.command, '?');
      assert.equal(conn.displayText, '?');
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
      assert.equal(conn.displayText, '\u2713 Approved');
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
      assert.equal(conn.displayText, '\u2717 Denied');
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
      assert.equal(conn._elapsedTimer, null);
      assert.equal(conn._subscribers.size, 0);
      // Notify after teardown should not call old subscriber.
      conn._notify();
      assert.equal(calls, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 12. _extractDisplayText
  // -------------------------------------------------------------------------
  describe('_extractDisplayText', () => {
    it('returns empty string for empty input', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText(''), '');
      assert.equal(conn._extractDisplayText(null), '');
      conn._teardown();
    });

    it('strips bold markdown', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('**bold text**'), 'bold text');
      conn._teardown();
    });

    it('strips italic markdown', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('*italic text*'), 'italic text');
      conn._teardown();
    });

    it('strips heading markers', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('## Heading'), 'Heading');
      conn._teardown();
    });

    it('strips inline code backticks', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('use `npm install`'), 'use npm install');
      conn._teardown();
    });

    it('strips markdown links, keeping label', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('[click here](http://example.com)'), 'click here');
      conn._teardown();
    });

    it('collapses newlines and whitespace', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('line one\n\nline two'), 'line one line two');
      conn._teardown();
    });

    it('extracts last sentence from long text', () => {
      const conn = freshConnection();
      // Build text longer than 200 chars to trigger truncation
      const prefix = 'A'.repeat(180) + '. ';
      const last = 'This is the final sentence.';
      const result = conn._extractDisplayText(prefix + last);
      assert.ok(result.includes('This is the final sentence.'));
      conn._teardown();
    });

    it('returns short text unchanged (after markdown strip)', () => {
      const conn = freshConnection();
      assert.equal(conn._extractDisplayText('Hello world'), 'Hello world');
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 13. _shortModel
  // -------------------------------------------------------------------------
  describe('_shortModel', () => {
    it('returns empty string when no model set', () => {
      const conn = freshConnection();
      assert.equal(conn._shortModel(), '');
      conn._teardown();
    });

    it('extracts sonnet from full model path', () => {
      const conn = freshConnection();
      conn.currentModel = 'anthropic/claude-sonnet-4-5';
      assert.equal(conn._shortModel(), 'sonnet');
      conn._teardown();
    });

    it('extracts opus from model name', () => {
      const conn = freshConnection();
      conn.currentModel = 'claude-opus-4';
      assert.equal(conn._shortModel(), 'opus');
      conn._teardown();
    });

    it('extracts haiku from model name', () => {
      const conn = freshConnection();
      conn.currentModel = 'anthropic/claude-haiku-3';
      assert.equal(conn._shortModel(), 'haiku');
      conn._teardown();
    });

    it('extracts gpt-4 from model name', () => {
      const conn = freshConnection();
      conn.currentModel = 'openai/gpt-4o';
      assert.equal(conn._shortModel(), 'gpt-4');
      conn._teardown();
    });

    it('extracts gemini from model name', () => {
      const conn = freshConnection();
      conn.currentModel = 'google/gemini-pro';
      assert.equal(conn._shortModel(), 'gemini');
      conn._teardown();
    });

    it('falls back to last segment after /', () => {
      const conn = freshConnection();
      conn.currentModel = 'provider/my-model';
      assert.equal(conn._shortModel(), 'my-model');
      conn._teardown();
    });

    it('truncates long fallback to 12 chars', () => {
      const conn = freshConnection();
      conn.currentModel = 'provider/a-very-long-model-name';
      assert.equal(conn._shortModel(), 'a-very-long-');
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 14. Elapsed timer
  // -------------------------------------------------------------------------
  describe('elapsed timer', () => {
    it('lifecycle start begins the elapsed timer', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.notEqual(conn.thinkingStarted, null);
      assert.notEqual(conn._elapsedTimer, null);
      assert.equal(conn.elapsed, '0s');
      conn._teardown();
    });

    it('lifecycle end stops the elapsed timer', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
      assert.equal(conn._elapsedTimer, null);
      assert.equal(conn.thinkingStarted, null);
      conn._teardown();
    });

    it('lifecycle error stops the elapsed timer', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'error', error: 'fail' } });
      assert.equal(conn._elapsedTimer, null);
      assert.equal(conn.thinkingStarted, null);
      conn._teardown();
    });

    it('statusDetail shows elapsed when thinking', () => {
      const conn = freshConnection();
      conn.elapsed = '3s';
      conn._setStatus('thinking');
      assert.equal(conn.statusDetail, '3s');
      conn._teardown();
    });

    it('statusDetail is cleared on idle', () => {
      const conn = freshConnection();
      conn.elapsed = '5s';
      conn._setStatus('thinking');
      assert.equal(conn.statusDetail, '5s');
      conn._setStatus('idle');
      assert.equal(conn.statusDetail, '');
      conn._teardown();
    });

    it('teardown clears the elapsed timer', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.notEqual(conn._elapsedTimer, null);
      conn._teardown();
      assert.equal(conn._elapsedTimer, null);
    });
  });

  // -------------------------------------------------------------------------
  // 15. Risk assessment on approval
  // -------------------------------------------------------------------------
  describe('risk assessment', () => {
    it('rm -r is HIGH risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'rm -r /tmp' } });
      assert.equal(conn.pendingApproval.risk, 'HIGH');
      conn._teardown();
    });

    it('rm -f is HIGH risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'rm -f file.txt' } });
      assert.equal(conn.pendingApproval.risk, 'HIGH');
      conn._teardown();
    });

    it('sudo rm is HIGH risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'sudo rm something' } });
      assert.equal(conn.pendingApproval.risk, 'HIGH');
      conn._teardown();
    });

    it('drop table is HIGH risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'drop table users' } });
      assert.equal(conn.pendingApproval.risk, 'HIGH');
      conn._teardown();
    });

    it('kill -9 is HIGH risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'kill -9 1234' } });
      assert.equal(conn.pendingApproval.risk, 'HIGH');
      conn._teardown();
    });

    it('ls is low risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'ls -la' } });
      assert.equal(conn.pendingApproval.risk, 'low');
      conn._teardown();
    });

    it('npm install is low risk', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'npm install express' } });
      assert.equal(conn.pendingApproval.risk, 'low');
      conn._teardown();
    });

    it('destructive commands get warning statusPhrase', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'rm -r /' } });
      assert.equal(conn.statusPhrase, '\u26A0 APPROVE?');
      conn._teardown();
    });

    it('non-destructive commands get normal approve phrase', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', { id: '1', request: { command: 'echo hello' } });
      assert.equal(conn.statusPhrase, 'approve?');
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 16. sourceSender tracking
  // -------------------------------------------------------------------------
  describe('sourceSender tracking', () => {
    it('tracks sender from agent events', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'thinking', sender: 'alice', data: { thinking: 'hmm' } });
      assert.equal(conn.sourceSender, 'alice');
      conn._teardown();
    });

    it('updates sender on subsequent events', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'thinking', sender: 'alice', data: { thinking: 'hmm' } });
      client.emit('agent', { stream: 'assistant', sender: 'bob', data: { delta: 'hi' } });
      assert.equal(conn.sourceSender, 'bob');
      conn._teardown();
    });

    it('sender is null initially', () => {
      const conn = freshConnection();
      assert.equal(conn.sourceSender, null);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 17. Model tracking in statusPhrase
  // -------------------------------------------------------------------------
  describe('model tracking in statusPhrase', () => {
    it('thinking includes model name when set', () => {
      const conn = freshConnection();
      conn.currentModel = 'anthropic/claude-sonnet-4-5';
      conn._setStatus('thinking');
      assert.equal(conn.statusPhrase, 'thinking (sonnet)');
      conn._teardown();
    });

    it('talking includes model name when set', () => {
      const conn = freshConnection();
      conn.currentModel = 'anthropic/claude-sonnet-4-5';
      conn._setStatus('talking');
      assert.equal(conn.statusPhrase, 'replying (sonnet)');
      conn._teardown();
    });

    it('thinking without model omits parenthetical', () => {
      const conn = freshConnection();
      conn.currentModel = null;
      conn._setStatus('thinking');
      assert.equal(conn.statusPhrase, 'thinking');
      conn._teardown();
    });

    it('working shows tool name in statusPhrase', () => {
      const conn = freshConnection();
      conn.currentTool = 'bash';
      conn._setStatus('working');
      assert.equal(conn.statusPhrase, '\u2699 bash');
      conn._teardown();
    });

    it('model is tracked from agent events', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'thinking', model: 'anthropic/claude-sonnet-4-5', data: { thinking: 'hmm' } });
      assert.equal(conn.currentModel, 'anthropic/claude-sonnet-4-5');
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 18. System stats
  // -------------------------------------------------------------------------
  describe('systemStats', () => {
    it('initializes with zeroed stats', () => {
      const conn = freshConnection();
      assert.deepEqual(conn.systemStats, {
        cpu: 0, cpuTemp: 0,
        gpu: 0, gpuTemp: 0,
        ram: 0, disk: 0,
        netDown: 0, netUp: 0,
      });
      conn._teardown();
    });

    it('updateSystemStats extracts fields from SDK payload', () => {
      const conn = freshConnection();
      conn.updateSystemStats({
        cpu: { usageInPercentage: 42, temperatureInCelsius: 65, clockInMhz: 3200, fanSpeedInRpm: 1200 },
        gpu: { usageInPercentage: 88, temperatureInCelsius: 72, clockInMhz: 1800, fanSpeedInRpm: 2000 },
        ram: { usageInPercentage: 55 },
        disk: { storageUsedInPercentage: 30 },
        network: { download: 1024, upload: 512 },
      });
      assert.deepEqual(conn.systemStats, {
        cpu: 42, cpuTemp: 65,
        gpu: 88, gpuTemp: 72,
        ram: 55, disk: 30,
        netDown: 1024, netUp: 512,
      });
      conn._teardown();
    });

    it('updateSystemStats notifies subscribers', () => {
      const conn = freshConnection();
      let notified = false;
      conn.onChange(() => { notified = true; });
      conn.updateSystemStats({
        cpu: { usageInPercentage: 10, temperatureInCelsius: 40 },
        gpu: { usageInPercentage: 5, temperatureInCelsius: 38 },
        ram: { usageInPercentage: 20 },
        disk: { storageUsedInPercentage: 15 },
        network: { download: 0, upload: 0 },
      });
      assert.ok(notified);
      conn._teardown();
    });

    it('updateSystemStats handles missing nested fields gracefully', () => {
      const conn = freshConnection();
      conn.updateSystemStats({});
      assert.deepEqual(conn.systemStats, {
        cpu: 0, cpuTemp: 0,
        gpu: 0, gpuTemp: 0,
        ram: 0, disk: 0,
        netDown: 0, netUp: 0,
      });
      conn._teardown();
    });

    it('updateSystemStats handles partially missing payload', () => {
      const conn = freshConnection();
      conn.updateSystemStats({
        cpu: { usageInPercentage: 33 },
        ram: { usageInPercentage: 77 },
      });
      assert.equal(conn.systemStats.cpu, 33);
      assert.equal(conn.systemStats.cpuTemp, 0);
      assert.equal(conn.systemStats.gpu, 0);
      assert.equal(conn.systemStats.gpuTemp, 0);
      assert.equal(conn.systemStats.ram, 77);
      assert.equal(conn.systemStats.disk, 0);
      assert.equal(conn.systemStats.netDown, 0);
      assert.equal(conn.systemStats.netUp, 0);
      conn._teardown();
    });

    it('updateSystemStats handles null/undefined gracefully', () => {
      const conn = freshConnection();
      conn.updateSystemStats(null);
      assert.deepEqual(conn.systemStats, {
        cpu: 0, cpuTemp: 0,
        gpu: 0, gpuTemp: 0,
        ram: 0, disk: 0,
        netDown: 0, netUp: 0,
      });
      conn._teardown();
    });

    it('updateSystemStats overwrites previous values', () => {
      const conn = freshConnection();
      conn.updateSystemStats({
        cpu: { usageInPercentage: 50, temperatureInCelsius: 60 },
        gpu: { usageInPercentage: 70, temperatureInCelsius: 80 },
        ram: { usageInPercentage: 40 },
        disk: { storageUsedInPercentage: 90 },
        network: { download: 100, upload: 200 },
      });
      conn.updateSystemStats({
        cpu: { usageInPercentage: 10, temperatureInCelsius: 30 },
        gpu: { usageInPercentage: 20, temperatureInCelsius: 35 },
        ram: { usageInPercentage: 15 },
        disk: { storageUsedInPercentage: 25 },
        network: { download: 50, upload: 75 },
      });
      assert.deepEqual(conn.systemStats, {
        cpu: 10, cpuTemp: 30,
        gpu: 20, gpuTemp: 35,
        ram: 15, disk: 25,
        netDown: 50, netUp: 75,
      });
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 19. displayMode tracking
  // -------------------------------------------------------------------------
  describe('displayMode', () => {
    it('starts in ambient mode', () => {
      const conn = freshConnection();
      assert.equal(conn.displayMode, 'ambient');
      conn._teardown();
    });

    it('switches to streaming when lifecycle starts', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.equal(conn.displayMode, 'streaming');
      conn._teardown();
    });

    it('returns to ambient when lifecycle ends', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.equal(conn.displayMode, 'streaming');
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
      assert.equal(conn.displayMode, 'ambient');
      conn._teardown();
    });

    it('switches to approval when exec approval arrives', () => {
      const { conn, client } = connectedPair();
      client.emit('exec.approval.requested', {
        id: 'a1',
        request: { command: 'ls' },
      });
      assert.equal(conn.displayMode, 'approval');
      conn._teardown();
    });

    it('stays streaming during thinking/talking/working transitions', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.equal(conn.displayMode, 'streaming');

      client.emit('agent', { stream: 'assistant', data: { delta: 'hi' } });
      assert.equal(conn.displayMode, 'streaming');

      client.emit('agent', { stream: 'tool', data: { phase: 'start', name: 'bash' } });
      assert.equal(conn.displayMode, 'streaming');
      conn._teardown();
    });

    it('does not reset agent mode on idle transition', () => {
      const conn = freshConnection();
      conn.displayMode = 'agent';
      conn._setStatus('idle');
      assert.equal(conn.displayMode, 'agent');
      conn._teardown();
    });

    it('goes to ambient on offline', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      assert.equal(conn.displayMode, 'streaming');
      client.emit('connection', { connected: false });
      assert.equal(conn.displayMode, 'ambient');
      conn._teardown();
    });

    it('approval mode set via _setStatus when pendingApproval exists', () => {
      const conn = freshConnection();
      conn.pendingApproval = { id: 'x', command: 'y', risk: 'low' };
      conn._setStatus('idle');
      assert.equal(conn.displayMode, 'approval');
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 20. lastActivity tracking
  // -------------------------------------------------------------------------
  describe('lastActivity', () => {
    it('is null initially', () => {
      const conn = freshConnection();
      assert.equal(conn.lastActivity, null);
      conn._teardown();
    });

    it('captures lastActivity on lifecycle end', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', {
        stream: 'lifecycle',
        channel: 'vscode',
        sender: 'alice',
        data: { phase: 'start' },
      });
      client.emit('agent', { stream: 'assistant', data: { delta: 'Here is your answer.' } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });

      assert.notEqual(conn.lastActivity, null);
      assert.equal(conn.lastActivity.channel, 'vscode');
      assert.equal(conn.lastActivity.sender, 'alice');
      assert.ok(conn.lastActivity.summary.length > 0);
      assert.ok(typeof conn.lastActivity.endedAt === 'number');
      assert.ok(conn.lastActivity.endedAt <= Date.now());
      conn._teardown();
    });

    it('summary is truncated to 120 characters', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      // Build long text
      const longText = 'A'.repeat(200);
      client.emit('agent', { stream: 'assistant', data: { delta: longText } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });

      assert.ok(conn.lastActivity.summary.length <= 120);
      conn._teardown();
    });

    it('summary defaults to "Completed task" when buffer is empty', () => {
      const { conn, client } = connectedPair();
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
      // No assistant/thinking text emitted — buffer stays empty
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });

      assert.equal(conn.lastActivity.summary, 'Completed task');
      conn._teardown();
    });

    it('preserves lastActivity across multiple lifecycle cycles', () => {
      const { conn, client } = connectedPair();
      // First cycle
      client.emit('agent', { stream: 'lifecycle', sender: 'alice', channel: 'vscode', data: { phase: 'start' } });
      client.emit('agent', { stream: 'assistant', data: { delta: 'First answer' } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
      const first = conn.lastActivity;

      // Second cycle
      client.emit('agent', { stream: 'lifecycle', sender: 'bob', channel: 'terminal', data: { phase: 'start' } });
      client.emit('agent', { stream: 'assistant', data: { delta: 'Second answer' } });
      client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
      const second = conn.lastActivity;

      assert.equal(second.sender, 'bob');
      assert.equal(second.channel, 'terminal');
      assert.ok(second.summary.includes('Second answer'));
      assert.ok(second.endedAt >= first.endedAt);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 21. Connection health tracking
  // -------------------------------------------------------------------------
  describe('connection health', () => {
    it('initializes health with zeroed values', () => {
      const conn = freshConnection();
      assert.deepEqual(conn.health, {
        connectedSince: 0,
        reconnects: 0,
        wasConnected: false,
      });
      conn._teardown();
    });

    it('tracks connectedSince timestamp on connect', () => {
      const { conn, client } = connectedPair();
      const before = Date.now();
      client.emit('connection', { connected: true });
      const after = Date.now();
      assert.ok(conn.health.connectedSince >= before);
      assert.ok(conn.health.connectedSince <= after);
      conn._teardown();
    });

    it('does NOT increment reconnects on first connect', () => {
      const { conn, client } = connectedPair();
      client.emit('connection', { connected: true });
      assert.equal(conn.health.reconnects, 0);
      assert.equal(conn.health.wasConnected, true);
      conn._teardown();
    });

    it('increments reconnect count on disconnect then reconnect', () => {
      const { conn, client } = connectedPair();
      // First connect
      client.emit('connection', { connected: true });
      assert.equal(conn.health.reconnects, 0);

      // Disconnect
      client.emit('connection', { connected: false });
      assert.equal(conn.health.reconnects, 0); // no change on disconnect

      // Reconnect
      client.emit('connection', { connected: true });
      assert.equal(conn.health.reconnects, 1);
      conn._teardown();
    });

    it('increments reconnects for each subsequent reconnect', () => {
      const { conn, client } = connectedPair();
      client.emit('connection', { connected: true });
      client.emit('connection', { connected: false });
      client.emit('connection', { connected: true });
      client.emit('connection', { connected: false });
      client.emit('connection', { connected: true });
      assert.equal(conn.health.reconnects, 2);
      conn._teardown();
    });

    it('updates connectedSince on each reconnect', () => {
      const { conn, client } = connectedPair();
      client.emit('connection', { connected: true });
      const first = conn.health.connectedSince;
      client.emit('connection', { connected: false });
      client.emit('connection', { connected: true });
      assert.ok(conn.health.connectedSince >= first);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 22. Slider
  // -------------------------------------------------------------------------
  describe('Slider', () => {
    it('stores slider value from gateway', () => {
      const { conn, client } = connectedPair();
      client.emit('modue.slider.set', { value: 75 });
      assert.equal(conn.sliderValue, 75);
      conn._teardown();
    });

    it('clamps slider value to 0-100', () => {
      const { conn, client } = connectedPair();
      client.emit('modue.slider.set', { value: 150 });
      assert.equal(conn.sliderValue, 100);
      client.emit('modue.slider.set', { value: -10 });
      assert.equal(conn.sliderValue, 0);
      conn._teardown();
    });

    it('notifies subscribers on slider change', () => {
      const { conn, client } = connectedPair();
      let notified = false;
      conn.onChange(() => { notified = true; });
      client.emit('modue.slider.set', { value: 50 });
      assert.ok(notified);
      conn._teardown();
    });

    it('drives physical slider instance', () => {
      const { conn, client } = connectedPair();
      let setTo = null;
      conn._sliderInstance = { set: (v) => { setTo = v; } };
      client.emit('modue.slider.set', { value: 42 });
      assert.equal(setTo, 42);
      conn._teardown();
    });

    it('ignores invalid payloads', () => {
      const { conn, client } = connectedPair();
      client.emit('modue.slider.set', { value: 'hello' });
      assert.equal(conn.sliderValue, 0); // unchanged
      client.emit('modue.slider.set', null);
      assert.equal(conn.sliderValue, 0);
      conn._teardown();
    });
  });

  // -------------------------------------------------------------------------
  // 23. Key labels
  // -------------------------------------------------------------------------
  describe('Key labels', () => {
    it('stores key labels from gateway', () => {
      const { conn, client } = connectedPair();
      client.emit('modue.key.labels', { left: 'Approve', center: 'Talk', right: 'Skip' });
      assert.equal(conn.keyLabels.left, 'Approve');
      assert.equal(conn.keyLabels.center, 'Talk');
      assert.equal(conn.keyLabels.right, 'Skip');
      conn._teardown();
    });

    it('defaults key labels to empty strings', () => {
      const conn = freshConnection();
      assert.equal(conn.keyLabels.left, '');
      assert.equal(conn.keyLabels.center, '');
      assert.equal(conn.keyLabels.right, '');
      conn._teardown();
    });

    it('updates partial key labels', () => {
      const { conn, client } = connectedPair();
      client.emit('modue.key.labels', { left: 'Yes' });
      assert.equal(conn.keyLabels.left, 'Yes');
      assert.equal(conn.keyLabels.center, '');
      assert.equal(conn.keyLabels.right, '');
      conn._teardown();
    });

    it('notifies on label change', () => {
      const { conn, client } = connectedPair();
      let notified = false;
      conn.onChange(() => { notified = true; });
      client.emit('modue.key.labels', { center: 'Menu' });
      assert.ok(notified);
      conn._teardown();
    });
  });
});
