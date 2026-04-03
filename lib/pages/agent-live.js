const { COLORS, truncate, agentLineColor } = require('../renderer');

const VISIBLE_LINES = 5;

class AgentLivePage {
  constructor(state, client, log) {
    this.state = state;
    this.client = client;
    this.log = log;
    this.scrollOffset = 0;
    this._unsubscribers = [];
  }

  activate() {
    this._unsubscribers.push(
      this.client.on('agent', (payload) => this._onAgentEvent(payload))
    );
    this._unsubscribers.push(
      this.client.on('exec.approval.requested', (payload) => this._onApprovalRequested(payload))
    );
    this._unsubscribers.push(
      this.client.on('exec.approval.resolved', (payload) => this._onApprovalResolved(payload))
    );
    this.scrollOffset = Math.max(0, this.state.agent.lines.length - VISIBLE_LINES);
  }

  deactivate() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  // --- Event handlers ---

  _onAgentEvent(evt) {
    if (!evt) return;

    if (evt.stream === 'lifecycle') {
      const phase = evt.data?.phase;
      if (phase === 'start') {
        this.state.updateAgent({ status: 'running', runId: evt.runId });
        this.state.addAgentLine('lifecycle', `Run started`);
      } else if (phase === 'end') {
        this.state.updateAgent({ status: 'idle', runId: null });
        this.state.addAgentLine('lifecycle', `Run completed`);
      } else if (phase === 'error') {
        this.state.updateAgent({ status: 'error' });
        this.state.addAgentLine('error', `Error: ${truncate(evt.data?.error?.message || 'unknown', 40)}`);
      }
    } else if (evt.stream === 'thinking') {
      const text = evt.data?.thinking || evt.data?.delta || '';
      if (text) {
        // Show last line of thinking, truncated
        const lastLine = text.split('\n').pop();
        this.state.addAgentLine('thinking', truncate(lastLine, 50));
      }
    } else if (evt.stream === 'assistant') {
      const delta = evt.data?.delta || '';
      if (delta) {
        // Accumulate text into the last assistant line, or start a new one
        const lines = this.state.agent.lines;
        const last = lines[lines.length - 1];
        if (last && last.type === 'assistant') {
          last.text = truncate(last.text + delta, 200);
          this.state._notify();
        } else {
          this.state.addAgentLine('assistant', delta);
        }
      }
    } else if (evt.stream === 'tool') {
      const phase = evt.data?.phase;
      if (phase === 'start') {
        const name = evt.data?.name || evt.data?.tool || 'tool';
        this.state.addAgentLine('tool', `\u{1f527} ${name}`);
      } else if (phase === 'end') {
        this.state.addAgentLine('tool-end', `  \u2713 done`);
      }
    }

    // Auto-scroll to bottom
    this.scrollOffset = Math.max(0, this.state.agent.lines.length - VISIBLE_LINES);
  }

  _onApprovalRequested(payload) {
    if (!payload) return;
    const approval = {
      id: payload.id,
      command: payload.request?.command || 'unknown command',
      expiresAtMs: payload.expiresAtMs,
    };
    this.state.updateAgent({ pendingApproval: approval });
    this.state.addAgentLine('approval', `\u26a0 APPROVE? ${truncate(approval.command, 35)}`);
    this.scrollOffset = Math.max(0, this.state.agent.lines.length - VISIBLE_LINES);
  }

  _onApprovalResolved(payload) {
    if (!payload) return;
    if (this.state.agent.pendingApproval?.id === payload.id) {
      this.state.updateAgent({ pendingApproval: null });
    }
  }

  // --- Controls ---

  onApprove() {
    const approval = this.state.agent.pendingApproval;
    if (!approval) {
      this.log.info('No pending approval');
      return;
    }
    this.client.rpc('exec.approval.resolve', {
      id: approval.id,
      decision: 'allow-once',
    }).then(() => {
      this.state.updateAgent({ pendingApproval: null });
      this.state.addAgentLine('lifecycle', '\u2713 Approved');
    }).catch((err) => {
      this.log.error(`Approve failed: ${err.message}`);
    });
  }

  onDeny() {
    const approval = this.state.agent.pendingApproval;
    if (!approval) {
      this.log.info('No pending approval');
      return;
    }
    this.client.rpc('exec.approval.resolve', {
      id: approval.id,
      decision: 'deny',
    }).then(() => {
      this.state.updateAgent({ pendingApproval: null });
      this.state.addAgentLine('lifecycle', '\u2717 Denied');
    }).catch((err) => {
      this.log.error(`Deny failed: ${err.message}`);
    });
  }

  onScroll(value) {
    // Knob value 0-100 maps to scroll position in the buffer
    const maxScroll = Math.max(0, this.state.agent.lines.length - VISIBLE_LINES);
    this.scrollOffset = Math.round((value / 100) * maxScroll);
    this.state._notify();
  }

  // --- Rendering ---

  render(layer, displayW, displayH) {
    const { agent } = this.state;

    // Header
    layer.addRow((row) => {
      row.setSize(displayW, 18).setBackgroundColor(COLORS.header);
      row.addDisplayText('h-title', (t) =>
        t.setText('AGENT LIVE')
          .setColor(COLORS.white)
          .setFontSize(11)
          .setFontWeight('bold')
          .setMargin(3, 6, 0, 6)
      );
      row.addDisplayText('h-status', (t) =>
        t.setText(agent.status.toUpperCase())
          .setColor(agent.status === 'running' ? COLORS.blue : agent.status === 'error' ? COLORS.red : COLORS.green)
          .setFontSize(10)
          .setFontWeight('bold')
          .setTextAlign('right')
          .setMargin(4, 6, 0, 0)
      );
    });

    // Text buffer area
    const visibleLines = agent.lines.slice(this.scrollOffset, this.scrollOffset + VISIBLE_LINES);
    for (let i = 0; i < VISIBLE_LINES; i++) {
      const line = visibleLines[i];
      layer.addRow((row) => {
        row.setSize(displayW, 16).setBackgroundColor(i % 2 === 0 ? COLORS.bg : COLORS.bgAlt);
        row.addDisplayText(`line-${i}`, (t) =>
          t.setText(line ? line.text : '')
            .setColor(line ? agentLineColor(line.type) : COLORS.textDim)
            .setFontSize(10)
            .setMargin(2, 6, 0, 6)
            .setTextWrap('ellipsis')
        );
      });
    }

    // Session label row
    layer.addRow((row) => {
      row.setSize(displayW, 14).setBackgroundColor(COLORS.bgAlt);
      row.addDisplayText('session-label', (t) =>
        t.setText(agent.sessionLabel ? `Session: ${truncate(agent.sessionLabel, 25)}` : 'No active session')
          .setColor(COLORS.textDim)
          .setFontSize(9)
          .setMargin(2, 6, 0, 6)
      );
    });

    // Footer — key labels
    const hasApproval = !!agent.pendingApproval;
    layer.addRow((row) => {
      row.setSize(displayW, 16).setBackgroundColor(COLORS.black);
      const labels = hasApproval
        ? ['\u25c0 PG', '\u25b2\u25bc SCROLL', '\u2714 APPROVE', '\u2718 DENY']
        : ['\u25c0 PG', '\u25b2\u25bc SCROLL', '', 'PG \u25b6'];
      const colW = Math.floor(displayW / labels.length);
      for (let i = 0; i < labels.length; i++) {
        row.addColumn((col) => {
          col.setSize(colW, 16);
          col.addDisplayText(`f-${i}`, (t) =>
            t.setText(labels[i])
              .setColor(hasApproval && i >= 2 ? COLORS.amber : COLORS.textDim)
              .setFontSize(8)
              .setTextAlign('center')
              .setMargin(4, 0, 0, 0)
          );
        });
      }
    });
  }

  getLedColors() {
    const { agent } = this.state;
    if (agent.pendingApproval) return 'amber-flash';
    if (agent.status === 'running') return 'blue-pulse';
    if (agent.status === 'error') return 'red';
    return 'green';
  }
}

module.exports = { AgentLivePage };
