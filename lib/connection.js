// Shared connection singleton — all display widgets subscribe here for state updates.
// Replaces lib/state.js with a unified connection + state + subscriber model.

const { OpenClawClient } = require('./ws-client');

// --- Constants ---

// Apple Watch-inspired status colors
const STATUS_COLORS = {
  idle:     '#30d158',    // iOS green
  thinking: '#bf5af2',    // iOS purple
  talking:  '#0a84ff',    // iOS blue
  working:  '#ff9f0a',    // iOS orange
  error:    '#ff453a',    // iOS red
  offline:  '#48484a',    // muted gray
};

const APPROVAL_COLOR = '#ff9f0a';

const IDLE_PHRASES = ['chillin\'', 'just vibing', 'all good', '\u{1F99E}', 'ready'];

const STATUS_PHRASES = {
  // idle is handled by cycling — see _startIdleCycle
  thinking: 'thinking',
  talking:  'replying',
  working:  'working',
  error:    'error',
  offline:  'offline',
};

const MAX_TEXT_LENGTH = 4000;
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
    this.displayMode = 'ambient';        // ambient | streaming | agent | approval
    this.lastActivity = null;            // { summary, channel, sender, endedAt }
    this._lastStream = null;             // tracks current stream phase for dedup

    // --- Key labels ---
    this.keyLabels = { left: '', center: '', right: '' };

    // --- Agent display override ---
    this.agentDisplay = null;  // null | { face?, title?, body?, image?, style?, raw?, widget?, ttl? }
    this._agentDisplayTimer = null;

    // --- LED override (agent-controlled) ---
    this.ledOverride = null; // null = default behavior, or { colors: [...] } or { pattern, color, speed }

    // --- Slider / scroll ---
    this.sliderValue = 0;
    this._sliderInstance = null; // set by index.js when slider initializes
    this.scrollMode = false;     // true when user is manually scrolling
    this.scrollOffset = 1.0;     // 0.0 = start of text, 1.0 = end (latest)
    this._scrollResetTimer = null; // auto-reset to live after inactivity

    // --- Connection health ---
    this.health = {
      connectedSince: 0,   // timestamp of current connection
      reconnects: 0,       // number of reconnections
      wasConnected: false,  // track if we've been connected before
    };

    // --- System resource stats (populated via useSystemMonitorResources) ---
    this.systemStats = {
      cpu: 0, cpuTemp: 0,
      gpu: 0, gpuTemp: 0,
      ram: 0, disk: 0,
      netDown: 0, netUp: 0,
    };
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
    this._log.info(`connect() url=${url} token=${token ? token.length + ' chars, type=' + typeof token + ', first4=' + String(token).slice(0, 4) : 'EMPTY'}`);

    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }

    this._client = new OpenClawClient(url, token, this._log, this._storage);
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
  // Slider — outbound (user moved the physical fader)
  // ---------------------------------------------------------------------------

  sendSliderChanged(value) {
    if (!this._client) return;
    this._client.rpc('modue.slider.changed', { value }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Touch — outbound (user touched a display widget)
  // ---------------------------------------------------------------------------

  sendTouch(widget, gesture) {
    if (!this._client) return;
    this._client.rpc('modue.display.touched', { widget, gesture }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // RPC passthrough (for widgets that need to call gateway methods)
  // ---------------------------------------------------------------------------

  rpc(method, params) {
    if (!this._client) return Promise.reject(new Error('Not connected'));
    return this._client.rpc(method, params);
  }

  // ---------------------------------------------------------------------------
  // System resource stats
  // ---------------------------------------------------------------------------

  /**
   * Update system stats from the SDK's SystemMonitorResourcesPayload.
   * Called by useSystemMonitorResources handler registered on the LED cluster.
   */
  updateSystemStats(resources) {
    const r = resources || {};
    this.systemStats = {
      cpu:     r.cpu?.usageInPercentage       || 0,
      cpuTemp: r.cpu?.temperatureInCelsius    || 0,
      gpu:     r.gpu?.usageInPercentage       || 0,
      gpuTemp: r.gpu?.temperatureInCelsius    || 0,
      ram:     r.ram?.usageInPercentage       || 0,
      disk:    r.disk?.storageUsedInPercentage || 0,
      netDown: r.network?.download            || 0,
      netUp:   r.network?.upload              || 0,
    };
    this._notify();
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

    // Agent override — direct colors
    if (this.ledOverride?.colors) {
      const c = this.ledOverride.colors;
      return Array.from({ length: n }, (_, i) => c[i % c.length] || null);
    }

    // Agent override — pattern
    if (this.ledOverride?.pattern) {
      return this._patternColors(n, frame, this.ledOverride);
    }

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
  // Internal — LED pattern engine
  // ---------------------------------------------------------------------------

  _patternColors(n, frame, override) {
    const { pattern, color, speed } = override;
    const cycle = Math.floor(frame * (speed / 5));
    switch (pattern) {
      case 'solid':
        return Array(n).fill(`${color}FF`);
      case 'flash': {
        const on = cycle % 2 === 0;
        return Array(n).fill(on ? `${color}FF` : '#00000000');
      }
      case 'pulse': {
        const alpha = Math.abs(Math.sin(cycle * 0.3));
        const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
        return Array(n).fill(`${color}${hex}`);
      }
      case 'breathe': {
        const brightness = (Math.sin(cycle * 0.15) + 1) / 2;
        const hex = Math.round(brightness * 255).toString(16).padStart(2, '0');
        return Array(n).fill(`${color}${hex}`);
      }
      case 'chase': {
        const active = cycle % n;
        return Array.from({ length: n }, (_, i) => i === active ? `${color}FF` : `${color}22`);
      }
      default:
        return Array(n).fill(`${color}FF`);
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
        if (this.health.wasConnected) {
          this.health.reconnects++;
        }
        this.health.connectedSince = Date.now();
        this.health.wasConnected = true;
        this._setStatus('idle');

        // Prime the bridge extension so it captures broadcast() for agent tools
        this._client.rpc('modue.bridge.ping', {}).then(() => {
          this._log.info('modue bridge primed');
        }).catch((e) => {
          this._log.warn(`bridge ping failed: ${e.message}`);
        });

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
      this.displayMode = 'approval';
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

    c.on('modue.slider.set', (payload) => {
      if (payload && typeof payload.value === 'number') {
        this.sliderValue = Math.max(0, Math.min(100, payload.value));
        if (this._sliderInstance) {
          try { this._sliderInstance.set(this.sliderValue); } catch (_) {}
        }
        this._notify();
      }
    });

    c.on('modue.leds.set', (payload) => {
      if (payload?.colors) {
        this.ledOverride = { colors: payload.colors };
        this._notify();
      }
    });

    c.on('modue.leds.pattern', (payload) => {
      if (payload?.pattern) {
        this.ledOverride = {
          pattern: payload.pattern,
          color: payload.color || '#ffffff',
          speed: payload.speed || 5,
        };
        this._notify();
      }
    });

    c.on('modue.leds.release', () => {
      this.ledOverride = null;
      this._notify();
    });

    c.on('modue.display.set', (payload) => {
      if (!payload) return;
      this.agentDisplay = {
        face: payload.face || null,
        title: payload.title || null,
        body: payload.body || null,
        image: payload.image || null,
        style: payload.style || null,
        widget: payload.widget || null,
        raw: null,
      };
      this.displayMode = 'agent';
      this._startAgentDisplayTtl(payload.ttl);
      this._notify();
    });

    c.on('modue.display.raw', (payload) => {
      if (!payload) return;
      this.agentDisplay = {
        face: null, title: null, body: null, image: null, style: null,
        widget: payload.widget || null,
        raw: payload,
      };
      this.displayMode = 'agent';
      this._startAgentDisplayTtl(payload.ttl);
      this._notify();
    });

    c.on('modue.display.release', () => {
      this._releaseAgentDisplay();
    });

    c.on('modue.key.labels', (payload) => {
      if (payload) {
        if (payload.left !== undefined) this.keyLabels.left = String(payload.left);
        if (payload.center !== undefined) this.keyLabels.center = String(payload.center);
        if (payload.right !== undefined) this.keyLabels.right = String(payload.right);
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
      this._lastStream = null;
      this.thinkingStarted = Date.now();
      this._startElapsedTimer();
      // Extract model from lifecycle event if available
      if (evt.data?.model) this.currentModel = evt.data.model;
      this._setStatus('thinking');
    } else if (phase === 'end') {
      // Capture lastActivity BEFORE clearing state
      this.lastActivity = {
        summary: this._extractDisplayText(this._rawBuffer).slice(0, 120) || 'Completed task',
        channel: this.sourceChannel,
        sender: this.sourceSender,
        endedAt: Date.now(),
      };
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
    const delta = evt.data?.delta || '';
    const accum = evt.data?.thinking || '';
    if (delta && !accum) {
      // Pure delta — append
      this._appendText(delta);
    } else if (accum) {
      // Accumulated (or both) — always replace, never append
      if (accum !== this._rawBuffer) {
        this._rawBuffer = accum;
        this.currentText = this._rawBuffer;
        this.displayText = this._extractDisplayText(this._rawBuffer);
      }
    }
  }

  _handleAssistant(evt) {
    // Clear thinking buffer when assistant stream begins
    if (this._lastStream !== 'assistant') {
      this._rawBuffer = '';
      this.currentText = '';
      this.displayText = '';
    }
    this._lastStream = 'assistant';
    this._setStatus('talking');
    const delta = evt.data?.delta || '';
    const accum = evt.data?.text || '';
    if (delta && !accum) {
      // Pure incremental delta
      this._appendText(delta);
    } else if (accum) {
      // Accumulated text — replace entirely (dedup)
      if (accum !== this._rawBuffer) {
        this._rawBuffer = accum;
        this.currentText = this._rawBuffer;
        this.displayText = this._extractDisplayText(this._rawBuffer);
      }
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
    // Don't update display if user is actively scrolling
    if (!this.scrollMode) {
      this.displayText = this._extractDisplayText(this._rawBuffer);
    }
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

  /**
   * Get display text at the current scroll position.
   * When scrollMode is false (live), returns the tail (latest text).
   * When scrollMode is true, returns a window at scrollOffset position.
   */
  getScrolledDisplayText() {
    if (!this._rawBuffer) return this.displayText || '';
    if (!this.scrollMode) return this.displayText || '';

    // Clean the full buffer the same way as _extractDisplayText
    let clean = this._rawBuffer
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#{1,6}\s*/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '\u2022 ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[^\S\n]+/g, ' ')
      .trim();

    if (clean.length <= DISPLAY_TEXT_LENGTH) return clean;

    // Map scrollOffset (0.0 - 1.0) to character position
    const maxStart = clean.length - DISPLAY_TEXT_LENGTH;
    const startPos = Math.round(this.scrollOffset * maxStart);
    const window = clean.slice(startPos, startPos + DISPLAY_TEXT_LENGTH);

    // Try to start at a word boundary
    if (startPos > 0) {
      const firstSpace = window.indexOf(' ');
      if (firstSpace >= 0 && firstSpace < 30) {
        return window.slice(firstSpace + 1);
      }
    }
    return window;
  }

  /**
   * Called when user physically moves the slider.
   * Enters scroll mode and maps slider position to text offset.
   */
  handleSliderScroll(value) {
    // Slider 0 = bottom (latest), 100 = top (oldest)
    // Map to scrollOffset: 0.0 = start, 1.0 = end
    this.scrollOffset = 1.0 - (value / 100);
    this.scrollMode = true;

    // Update display with scrolled text
    this.displayText = this.getScrolledDisplayText();
    this._notify();

    // Auto-reset to live mode after 5s of no scrolling
    if (this._scrollResetTimer) clearTimeout(this._scrollResetTimer);
    this._scrollResetTimer = setTimeout(() => {
      this.scrollMode = false;
      this.scrollOffset = 1.0;
      this.displayText = this._extractDisplayText(this._rawBuffer);
      this._notify();
    }, 5000);
  }

  _setStatus(status) {
    const prev = this.agentStatus;
    this.agentStatus = status;
    this._refreshMoodColor();

    // Update displayMode based on new status
    if (this.pendingApproval) {
      this.displayMode = 'approval';
    } else if (status === 'idle' || status === 'offline') {
      // Release to ambient UNLESS in agent mode (agent is only released explicitly)
      if (this.displayMode !== 'agent') {
        this.displayMode = 'ambient';
      }
    } else {
      // thinking, talking, working — streaming
      this.displayMode = 'streaming';
    }

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
  // Internal — agent display TTL
  // ---------------------------------------------------------------------------

  _startAgentDisplayTtl(ttl) {
    if (this._agentDisplayTimer) clearTimeout(this._agentDisplayTimer);
    this._agentDisplayTimer = null;
    if (ttl && ttl > 0) {
      this._agentDisplayTimer = setTimeout(() => {
        this._releaseAgentDisplay();
      }, ttl * 1000);
    }
  }

  _releaseAgentDisplay() {
    if (this._agentDisplayTimer) { clearTimeout(this._agentDisplayTimer); this._agentDisplayTimer = null; }
    this.agentDisplay = null;
    if (this.displayMode === 'agent') {
      this.displayMode = 'ambient';
    }
    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Internal — teardown
  // ---------------------------------------------------------------------------

  _teardown() {
    this.disconnect();
    this._stopIdleCycle();
    this._stopElapsedTimer();
    if (this._agentDisplayTimer) { clearTimeout(this._agentDisplayTimer); this._agentDisplayTimer = null; }
    this._subscribers.clear();
  }
}

module.exports = { Connection, STATUS_COLORS, IDLE_PHRASES, STATUS_PHRASES };
