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

const IDLE_PHRASES = ['chillin\'', 'just vibing', 'all good', '\u{1F99E}', 'ready'];

const STATUS_PHRASES = {
  // idle is handled by cycling — see _startIdleCycle
  thinking: 'thinking',
  talking:  'replying',
  working:  'working',
  error:    'error',
  offline:  'offline',
};

const MAX_TEXT_LENGTH = 1200;
const DISPLAY_TEXT_LENGTH = 600;

const DESTRUCTIVE_PATTERNS = /\b(rm\s+-r|rm\s+-f|rmdir|drop\s+|delete\s+|truncate|kill\s+-9|sudo\s+rm|format|mkfs|dd\s+if=)\b/i;

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
    this.displayText = '';              // cleaned, last-sentence version for display
    this._rawBuffer = '';
    this.statusPhrase = 'offline';
    this.statusDetail = '';             // e.g. model name, tool name
    this.pendingApproval = null;        // null | { id, command, risk }
    this.sourceChannel = null;
    this.sourceSender = null;           // who sent the message
    this.currentModel = null;
    this.currentTool = null;
    this.thinkingStarted = null;        // timestamp for elapsed timer
    this.elapsed = '';                  // '4.2s', '1m 12s'
    this._elapsedTimer = null;
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
        this.displayText = '\u2713 Approved';
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
        this.displayText = '\u2717 Denied';
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

      // Track source channel + sender if available
      if (evt.channel) this.sourceChannel = evt.channel;
      if (evt.sender) this.sourceSender = evt.sender;
      if (evt.model) this.currentModel = evt.model;

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
      const cmd = payload.request?.command || '?';
      const isDestructive = DESTRUCTIVE_PATTERNS.test(cmd);
      this.pendingApproval = {
        id: payload.id,
        command: cmd,
        risk: isDestructive ? 'HIGH' : 'low',
      };
      this.moodColor = APPROVAL_COLOR;
      this.statusPhrase = isDestructive ? '\u26A0 APPROVE?' : 'approve?';
      this.displayText = cmd;
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
      this._rawBuffer = '';
      this.displayText = '';
      this.currentText = '';
      this.currentTool = null;
      this.thinkingStarted = Date.now();
      this._startElapsedTimer();
      // Extract model from lifecycle event if available
      if (evt.data?.model) this.currentModel = evt.data.model;
      this._setStatus('thinking');
    } else if (phase === 'end') {
      this._stopElapsedTimer();
      this._setStatus('idle');
      // Keep last displayText visible
    } else if (phase === 'error') {
      this._stopElapsedTimer();
      this._setStatus('error');
      this.displayText = String(evt.data?.error || 'Unknown error');
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
    // Clear thinking text when assistant starts talking
    if (this.agentStatus === 'thinking') {
      this._rawBuffer = '';
      this.currentText = '';
      this.displayText = '';
    }
    this._setStatus('talking');
    const delta = evt.data?.delta || '';
    if (delta) {
      this._appendText(delta);
    }
  }

  _handleTool(evt) {
    const name = evt.data?.name || null;
    if (evt.data?.phase === 'start') {
      this.currentTool = name;
      this._rawBuffer = '';
      this.currentText = '';
      this._setStatus('working');
      this.displayText = name ? `\u2699 ${name}` : 'running tool...';
    } else if (evt.data?.phase === 'end') {
      this.currentTool = null;
      this._rawBuffer = '';
      this.currentText = '';
      this._setStatus('working');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — state helpers
  // ---------------------------------------------------------------------------

  _appendText(text) {
    this._rawBuffer += text;
    if (this._rawBuffer.length > MAX_TEXT_LENGTH) {
      this._rawBuffer = this._rawBuffer.slice(-MAX_TEXT_LENGTH);
    }
    this.currentText = this._rawBuffer;
    // Build a cleaned display version: last meaningful chunk
    this.displayText = this._extractDisplayText(this._rawBuffer);
  }

  /**
   * Extract readable text for the small display.
   * Strips inline markdown but preserves paragraph structure.
   * Shows a rolling window of the most recent content.
   */
  _extractDisplayText(raw) {
    if (!raw) return '';

    let clean = raw
      // Strip inline markdown but keep structure
      .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold** → bold
      .replace(/\*([^*]+)\*/g, '$1')            // *italic* → italic
      .replace(/#{1,6}\s*/g, '')                // ### headers → plain
      .replace(/`([^`]+)`/g, '$1')              // `code` → code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
      // Clean up bullet points: - item → • item
      .replace(/^\s*[-*]\s+/gm, '\u2022 ')
      // Collapse multiple blank lines into one
      .replace(/\n{3,}/g, '\n\n')
      // Collapse multiple spaces (but not newlines)
      .replace(/[^\S\n]+/g, ' ')
      .trim();

    if (clean.length <= DISPLAY_TEXT_LENGTH) return clean;

    // Take the tail, but try to start at a paragraph or sentence boundary
    const tail = clean.slice(-DISPLAY_TEXT_LENGTH);

    // Prefer starting at a paragraph break
    const paraBreak = tail.indexOf('\n\n');
    if (paraBreak >= 0 && paraBreak < 100) {
      return tail.slice(paraBreak + 2).trim();
    }

    // Next: start at a sentence boundary
    const sentenceBreak = tail.search(/[.!?]\s/);
    if (sentenceBreak >= 0 && sentenceBreak < 80) {
      return tail.slice(sentenceBreak + 2).trim();
    }

    // Next: start at a line break
    const lineBreak = tail.indexOf('\n');
    if (lineBreak >= 0 && lineBreak < 60) {
      return tail.slice(lineBreak + 1).trim();
    }

    // Fallback: break at word boundary
    const firstSpace = tail.indexOf(' ');
    if (firstSpace >= 0 && firstSpace < 40) {
      return tail.slice(firstSpace + 1);
    }

    return tail;
  }

  _setStatus(status) {
    const prev = this.agentStatus;
    this.agentStatus = status;
    this._refreshMoodColor();

    // Update status phrase with context
    if (status === 'idle') {
      this.statusPhrase = IDLE_PHRASES[this._idlePhraseIndex % IDLE_PHRASES.length];
      this.statusDetail = '';
      if (prev !== 'idle') {
        this._startIdleCycle();
      }
    } else {
      this._stopIdleCycle();
      const modelShort = this._shortModel();
      if (status === 'thinking') {
        this.statusPhrase = modelShort ? `thinking (${modelShort})` : 'thinking';
        this.statusDetail = this.elapsed;
      } else if (status === 'talking') {
        this.statusPhrase = modelShort ? `replying (${modelShort})` : 'replying';
        this.statusDetail = this.elapsed;
      } else if (status === 'working') {
        this.statusPhrase = this.currentTool ? `\u2699 ${this.currentTool}` : 'working';
        this.statusDetail = this.elapsed;
      } else if (status === 'error') {
        this.statusPhrase = 'error';
        this.statusDetail = '';
      } else {
        this.statusPhrase = STATUS_PHRASES[status] || status;
        this.statusDetail = '';
      }
    }
  }

  /** Shorten model name for display: 'anthropic/claude-sonnet-4-5' → 'sonnet' */
  _shortModel() {
    const m = this.currentModel;
    if (!m) return '';
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    if (m.includes('gpt-4')) return 'gpt-4';
    if (m.includes('gemini')) return 'gemini';
    // Fallback: last segment after /
    const parts = m.split('/');
    const last = parts[parts.length - 1];
    return last.length > 12 ? last.slice(0, 12) : last;
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

  // ---------------------------------------------------------------------------
  // Internal — elapsed timer
  // ---------------------------------------------------------------------------

  _startElapsedTimer() {
    this._stopElapsedTimer();
    this.thinkingStarted = Date.now();
    this.elapsed = '0s';
    this._elapsedTimer = setInterval(() => {
      if (!this.thinkingStarted) { this._stopElapsedTimer(); return; }
      const diffMs = Date.now() - this.thinkingStarted;
      const secs = Math.floor(diffMs / 1000);
      if (secs < 60) {
        this.elapsed = `${secs}s`;
      } else {
        const mins = Math.floor(secs / 60);
        const rem = secs % 60;
        this.elapsed = `${mins}m ${rem}s`;
      }
      // Update status detail with elapsed
      if (this.agentStatus !== 'idle' && this.agentStatus !== 'offline') {
        this.statusDetail = this.elapsed;
        this._notify();
      }
    }, 1000);
  }

  _stopElapsedTimer() {
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
    this.thinkingStarted = null;
  }

  // ---------------------------------------------------------------------------
  // Internal — teardown
  // ---------------------------------------------------------------------------

  _teardown() {
    this.disconnect();
    this._stopIdleCycle();
    this._stopElapsedTimer();
    this._subscribers.clear();
  }
}

module.exports = { Connection, STATUS_COLORS, IDLE_PHRASES, STATUS_PHRASES };
