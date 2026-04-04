// Shared connection singleton — all display widgets subscribe here for state updates.
// Replaces lib/state.js with a unified connection + state + subscriber model.

const { OpenClawClient } = require('./ws-client');

// --- Constants ---

const STATUS_COLORS = {
  idle:     '#31e000',
  thinking: '#9944FF',
  talking:  '#4488ff',
  working:  '#ff9900',
  error:    '#ff3333',
  offline:  '#333344',
};

const APPROVAL_COLOR = '#ff9900';

const IDLE_PHRASES = ['chillin\'', 'just vibing', 'all good', '\u{1F99E}'];

const STATUS_PHRASES = {
  // idle is handled by cycling — see _startIdleCycle
  thinking: 'hmm...',
  talking:  'ok so...',
  working:  '*tinkering*',
  error:    'ow.',
  offline:  'zzz',
};

const MAX_TEXT_LENGTH = 300;

// --- Singleton ---

let _instance = null;

class Connection {
  /**
   * Get (or create) the singleton.
   *   storage — plugin storage (storage.get / storage.set)
   *   log     — plugin logger  (log.info / log.error / log.warn)
   *
   * Both are optional on subsequent calls — only needed on first init.
   */
  static getInstance(storage, log) {
    if (!_instance) {
      if (!storage || !log) {
        throw new Error('Connection.getInstance() requires storage and log on first call');
      }
      _instance = new Connection(storage, log);
    }
    return _instance;
  }

  /** Tear down the singleton (for tests or plugin deactivation). */
  static destroy() {
    if (_instance) {
      _instance._teardown();
      _instance = null;
    }
  }

  constructor(storage, log) {
    this._storage = storage;
    this._log = log;
    this._client = null;
    this._subscribers = new Set();
    this._idleTimer = null;
    this._idlePhraseIndex = 0;

    // --- Public state (read-only outside this module) ---
    this.connected = false;
    this.agentStatus = 'offline';       // idle | thinking | talking | working | error | offline
    this.currentText = '';
    this.statusPhrase = 'zzz';
    this.pendingApproval = null;        // null | { id, command }
    this.sourceChannel = null;
    this.moodColor = STATUS_COLORS.offline;
  }

  // ---------------------------------------------------------------------------
  // Subscriber pattern
  // ---------------------------------------------------------------------------

  /** Register a change listener. Returns an unsubscribe function. */
  onChange(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _notify() {
    for (const fn of this._subscribers) {
      try { fn(this); } catch (e) {
        this._log.error(`Connection subscriber error: ${e.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /** Connect (or reconnect) to the OpenClaw gateway. */
  connect() {
    const url = this._storage.get('gatewayUrl') || 'ws://127.0.0.1:18789';
    const token = this._storage.get('gatewayToken') || '';

    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }

    this._client = new OpenClawClient(url, token, this._log);
    this._wireEvents();
    this._client.connect();
  }

  /** Disconnect from the gateway. */
  disconnect() {
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
    this._stopIdleCycle();
  }

  // ---------------------------------------------------------------------------
  // Approval flow
  // ---------------------------------------------------------------------------

  approveExec() {
    const a = this.pendingApproval;
    if (!a || !this._client) return;
    this._client.rpc('exec.approval.resolve', { id: a.id, decision: 'allow-once' })
      .then(() => {
        this.pendingApproval = null;
        this._setStatus('idle');
        this.currentText = 'Approved';
        this._notify();
      })
      .catch((e) => this._log.error(`Approve: ${e.message}`));
  }

  denyExec() {
    const a = this.pendingApproval;
    if (!a || !this._client) return;
    this._client.rpc('exec.approval.resolve', { id: a.id, decision: 'deny' })
      .then(() => {
        this.pendingApproval = null;
        this._setStatus('idle');
        this.currentText = 'Denied';
        this._notify();
      })
      .catch((e) => this._log.error(`Deny: ${e.message}`));
  }

  // ---------------------------------------------------------------------------
  // RPC passthrough (for widgets that need to call gateway methods)
  // ---------------------------------------------------------------------------

  rpc(method, params) {
    if (!this._client) return Promise.reject(new Error('Not connected'));
    return this._client.rpc(method, params);
  }

  // ---------------------------------------------------------------------------
  // LED colors
  // ---------------------------------------------------------------------------

  /**
   * Return an array of `numLeds` hex-color strings for the current state.
   * `animFrame` is a monotonically increasing integer the caller bumps (e.g. every 500ms).
   */
  getLedColors(numLeds, animFrame) {
    const n = numLeds || 8;
    const frame = animFrame || 0;
    const even = frame % 2 === 0;

    // Flashing amber for pending approval
    if (this.pendingApproval) {
      return Array(n).fill(even ? '#ff9900FF' : '#00000000');
    }

    const mc = this.moodColor;

    switch (this.agentStatus) {
      case 'thinking':
        return Array(n).fill(even ? `${mc}FF` : `${mc}44`);
      case 'talking':
        return Array(n).fill(even ? `${mc}FF` : `${mc}66`);
      case 'working':
        return Array(n).fill(even ? `${mc}FF` : `${mc}66`);
      case 'error':
        return Array(n).fill(`${mc}FF`);
      case 'offline':
        return Array(n).fill(`${mc}44`);
      case 'idle':
      default:
        return Array(n).fill(`${mc}FF`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — event wiring
  // ---------------------------------------------------------------------------

  _wireEvents() {
    const c = this._client;

    c.on('connection', (info) => {
      this.connected = info.connected;
      if (info.connected) {
        this._setStatus('idle');
        this.currentText = 'Connected. Waiting for activity...';
      } else {
        this._setStatus('offline');
        this.currentText = 'Disconnected. Reconnecting...';
      }
      this._notify();
    });

    c.on('agent', (evt) => {
      if (!evt) return;

      // Track source channel if available
      if (evt.channel) {
        this.sourceChannel = evt.channel;
      }

      if (evt.stream === 'lifecycle') {
        this._handleLifecycle(evt);
      } else if (evt.stream === 'thinking') {
        this._handleThinking(evt);
      } else if (evt.stream === 'assistant') {
        this._handleAssistant(evt);
      } else if (evt.stream === 'tool') {
        this._handleTool(evt);
      }

      this._notify();
    });

    c.on('exec.approval.requested', (payload) => {
      if (!payload) return;
      this.pendingApproval = {
        id: payload.id,
        command: payload.request?.command || '?',
      };
      this.moodColor = APPROVAL_COLOR;
      this.statusPhrase = 'approve?';
      this.currentText = payload.request?.command || 'Approve this command?';
      this._notify();
    });

    c.on('exec.approval.resolved', (payload) => {
      if (this.pendingApproval?.id === payload?.id) {
        this.pendingApproval = null;
        this._refreshMoodColor();
        this._notify();
      }
    });
  }

  _handleLifecycle(evt) {
    const phase = evt.data?.phase;
    if (phase === 'start') {
      this.currentText = '';
      this._setStatus('idle'); // will quickly transition via thinking/assistant/tool
    } else if (phase === 'end') {
      this._setStatus('idle');
      // Keep last text visible
    } else if (phase === 'error') {
      this._setStatus('error');
      this.currentText = String(evt.data?.error || 'Unknown error');
    }
  }

  _handleThinking(evt) {
    this._setStatus('thinking');
    const text = evt.data?.thinking || evt.data?.delta || '';
    if (text) {
      this._appendText(text);
    }
  }

  _handleAssistant(evt) {
    this._setStatus('talking');
    const delta = evt.data?.delta || '';
    if (delta) {
      this._appendText(delta);
    }
  }

  _handleTool(evt) {
    if (evt.data?.phase === 'start') {
      this._setStatus('working');
      this.currentText = evt.data?.name || 'Running tool...';
    } else if (evt.data?.phase === 'end') {
      // Back to generic running — will get a lifecycle end or next stream event
      this._setStatus('working');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — state helpers
  // ---------------------------------------------------------------------------

  _appendText(text) {
    this.currentText += text;
    if (this.currentText.length > MAX_TEXT_LENGTH) {
      this.currentText = this.currentText.slice(-MAX_TEXT_LENGTH);
    }
  }

  _setStatus(status) {
    const prev = this.agentStatus;
    this.agentStatus = status;
    this._refreshMoodColor();

    // Update status phrase
    if (status === 'idle') {
      this.statusPhrase = IDLE_PHRASES[this._idlePhraseIndex % IDLE_PHRASES.length];
      if (prev !== 'idle') {
        this._startIdleCycle();
      }
    } else {
      this._stopIdleCycle();
      this.statusPhrase = STATUS_PHRASES[status] || status;
    }
  }

  _refreshMoodColor() {
    if (this.pendingApproval) {
      this.moodColor = APPROVAL_COLOR;
    } else {
      this.moodColor = STATUS_COLORS[this.agentStatus] || STATUS_COLORS.offline;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — idle phrase cycling
  // ---------------------------------------------------------------------------

  _startIdleCycle() {
    this._stopIdleCycle();
    this._idleTimer = setInterval(() => {
      if (this.agentStatus !== 'idle') {
        this._stopIdleCycle();
        return;
      }
      this._idlePhraseIndex++;
      this.statusPhrase = IDLE_PHRASES[this._idlePhraseIndex % IDLE_PHRASES.length];
      this._notify();
    }, 5000);
  }

  _stopIdleCycle() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — teardown
  // ---------------------------------------------------------------------------

  _teardown() {
    this.disconnect();
    this._stopIdleCycle();
    this._subscribers.clear();
  }
}

module.exports = { Connection, STATUS_COLORS, IDLE_PHRASES, STATUS_PHRASES };
