const PAGES = ['agent', 'channels', 'sessions', 'commands'];

class State {
  constructor() {
    this.currentPage = 'agent';
    this.connected = false;

    // Agent Live state
    this.agent = {
      status: 'idle', // idle | running | error
      lines: [],      // { type, text, ts }[] — last 50 lines
      runId: null,
      sessionKey: null,
      sessionLabel: null,
      pendingApproval: null, // { id, command, expiresAtMs }
    };

    // Channels state
    this.channels = {
      list: [],       // { name, accountId, connected, enabled, healthState, lastError, lastInboundAt, activeRuns }[]
      scrollOffset: 0,
    };

    // Sessions state
    this.sessions = {
      list: [],       // { sessionKey, label, status, startedAt, model, inputTokens, outputTokens, estimatedCostUsd, lastChannel, lastTo }[]
      selectedIndex: 0,
      scrollOffset: 0,
      detailView: false,
    };

    // Commands state
    this.commands = {
      slots: [],      // { label, actionType, params }[]
    };

    this._onChange = null;
  }

  setOnChange(fn) {
    this._onChange = fn;
  }

  update(partial) {
    Object.assign(this, partial);
    this._notify();
  }

  updateAgent(partial) {
    Object.assign(this.agent, partial);
    this._notify();
  }

  updateChannels(partial) {
    Object.assign(this.channels, partial);
    this._notify();
  }

  updateSessions(partial) {
    Object.assign(this.sessions, partial);
    this._notify();
  }

  addAgentLine(type, text) {
    this.agent.lines.push({ type, text, ts: Date.now() });
    if (this.agent.lines.length > 50) {
      this.agent.lines.shift();
    }
    this._notify();
  }

  clearAgentLines() {
    this.agent.lines = [];
    this._notify();
  }

  nextPage() {
    const idx = PAGES.indexOf(this.currentPage);
    this.currentPage = PAGES[(idx + 1) % PAGES.length];
    this._notify();
    return this.currentPage;
  }

  prevPage() {
    const idx = PAGES.indexOf(this.currentPage);
    this.currentPage = PAGES[(idx - 1 + PAGES.length) % PAGES.length];
    this._notify();
    return this.currentPage;
  }

  _notify() {
    if (this._onChange) {
      try {
        this._onChange(this);
      } catch (e) {
        // prevent listener errors from breaking state
      }
    }
  }
}

module.exports = { State, PAGES };
