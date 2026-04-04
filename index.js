const { OpenClawClient } = require('./lib/ws-client');
const { State } = require('./lib/state');
const { COLORS, truncate, agentLineColor } = require('./lib/renderer');

const openclawPlugin = (configuration, storage, log) => {
  const state = new State();
  let client = null;
  let displayInstance = null; // will hold instance.components
  let rawInstance = null;     // the raw instance for .set() on LEDs etc
  let ledInstance = null;
  let ledAnimFrame = 0;
  let ledAnimTimer = null;

  // ---------------------------------------------------------------------------
  // Global configuration
  // ---------------------------------------------------------------------------
  configuration
    .useConfiguration()
    .addInput(
      { key: 'gatewayUrl', name: 'Gateway URL', description: 'OpenClaw WebSocket URL (default: ws://127.0.0.1:18789)' },
      'string',
    )
    .addInput(
      { key: 'gatewayToken', name: 'Gateway Token', description: 'OPENCLAW_GATEWAY_TOKEN value' },
      'password',
    )
    .addButton({
      key: 'connectButton',
      name: 'Connect',
      description: 'Connect to OpenClaw gateway',
      renderer: () => client?.connected ? 'Connected' : 'Connect',
      handler: async () => {
        if (client) client.disconnect();
        initConnection();
      },
    });

  // ---------------------------------------------------------------------------
  // Display — 2x2 tile (120x120px), Option B: Live Stream layout
  //
  // Row 1 (24px): Lobster icon + status text
  // Row 2 (60px): 3 lines of streaming text (20px each)
  // Row 3 (18px): Nav footer
  // Total: ~102px + margins
  // ---------------------------------------------------------------------------
  configuration
    .registerDisplay({ name: 'OpenClaw' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer
        .setMargin(4, 4, 4, 4)
        .setBorderRadius(6, 6, 6, 6)
        .setBackgroundColor(COLORS.bg);

      // --- Header row: icon + status ---
      layer.addRow((row) => {
        row.setSize(112, 26).setBackgroundColor(COLORS.header);

        // Lobster emoji as text
        row.addColumn((col) => {
          col.setSize(26, 26);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(16)
              .setTextAlign('center')
              .setMargin(3, 0, 0, 4)
          );
        });

        // Status text
        row.addColumn((col) => {
          col.setSize(86, 26);
          col.addDisplayText('status', (t) =>
            t.setText('CONNECTING...')
              .setColor(COLORS.amber)
              .setFontSize(14)
              .setFontWeight('bold')
              .setMargin(5, 4, 0, 0)
          );
        });
      });

      // --- Content: 3 lines of streaming text ---
      layer.addRow((row) => {
        row.setSize(112, 22).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line1', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 6, 0, 6)
            .setTextWrap('ellipsis')
        );
      });

      layer.addRow((row) => {
        row.setSize(112, 22).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('line2', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 6, 0, 6)
            .setTextWrap('ellipsis')
        );
      });

      layer.addRow((row) => {
        row.setSize(112, 22).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line3', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 6, 0, 6)
            .setTextWrap('ellipsis')
        );
      });

      // --- Footer ---
      layer.addRow((row) => {
        row.setSize(112, 18).setBackgroundColor(COLORS.black);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(11)
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      rawInstance = instance;
      displayInstance = instance.components || {};
      log.info('Display initialized');
      initConnection();
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (client) client.disconnect();
      clearInterval(ledAnimTimer);
    });

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------
  configuration
    .registerKey({ name: 'Prev / Approve' })
    .registerOnKeyDownHandler(() => {
      if (state.agent.pendingApproval) {
        approveExec();
      } else {
        state.prevPage();
        refreshDisplay();
      }
    });

  configuration
    .registerKey({ name: 'Next / Deny' })
    .registerOnKeyDownHandler(() => {
      if (state.agent.pendingApproval) {
        denyExec();
      } else {
        state.nextPage();
        refreshDisplay();
      }
    });

  // ---------------------------------------------------------------------------
  // Knob
  // ---------------------------------------------------------------------------
  configuration
    .registerKnob({ name: 'Scroll' })
    .registerOnChangeHandler((value) => {
      if (state.currentPage === 'agent') {
        const maxScroll = Math.max(0, state.agent.lines.length - 3);
        state.agent._scrollOffset = Math.round((value / 100) * maxScroll);
        refreshDisplay();
      }
    });

  // ---------------------------------------------------------------------------
  // LEDs
  // ---------------------------------------------------------------------------
  configuration
    .registerLedCluster({ name: 'Status' })
    .registerOnInitializeHandler((instance) => {
      ledInstance = instance;
      updateLeds();
    })
    .registerOnDeactivateHandler(() => { ledInstance = null; });

  // ---------------------------------------------------------------------------
  // Connection & event handling
  // ---------------------------------------------------------------------------

  function initConnection() {
    const url = storage.get('gatewayUrl') || 'ws://127.0.0.1:18789';
    const token = storage.get('gatewayToken') || '';

    if (client) {
      client.disconnect();
    }

    client = new OpenClawClient(url, token, log);

    client.on('connection', (info) => {
      state.update({ connected: info.connected });
      refreshDisplay();
    });

    client.on('agent', (evt) => {
      if (!evt) return;

      if (evt.stream === 'lifecycle') {
        if (evt.data?.phase === 'start') {
          state.updateAgent({ status: 'running', runId: evt.runId });
          state.addAgentLine('lifecycle', 'Run started');
        } else if (evt.data?.phase === 'end') {
          state.updateAgent({ status: 'idle', runId: null });
          state.addAgentLine('lifecycle', 'Done');
        } else if (evt.data?.phase === 'error') {
          state.updateAgent({ status: 'error' });
          state.addAgentLine('error', truncate(String(evt.data?.error), 30));
        }
      } else if (evt.stream === 'thinking') {
        const text = evt.data?.thinking || evt.data?.delta || '';
        if (text) {
          state.updateAgent({ status: 'thinking' });
          const lastLine = text.split('\n').pop();
          state.addAgentLine('thinking', truncate(lastLine, 30));
        }
      } else if (evt.stream === 'assistant') {
        const delta = evt.data?.delta || '';
        if (delta) {
          state.updateAgent({ status: 'talking' });
          const lines = state.agent.lines;
          const last = lines[lines.length - 1];
          if (last && last.type === 'assistant') {
            last.text = truncate(last.text + delta, 80);
          } else {
            state.addAgentLine('assistant', delta);
          }
        }
      } else if (evt.stream === 'tool') {
        if (evt.data?.phase === 'start') {
          state.updateAgent({ status: 'working' });
          state.addAgentLine('tool', `\u2699 ${evt.data?.name || 'tool'}`);
        }
      }
      refreshDisplay();
    });

    client.on('exec.approval.requested', (payload) => {
      if (!payload) return;
      state.updateAgent({
        pendingApproval: {
          id: payload.id,
          command: payload.request?.command || '?',
          expiresAtMs: payload.expiresAtMs,
        }
      });
      state.addAgentLine('approval', truncate(payload.request?.command, 30));
      refreshDisplay();
    });

    client.on('exec.approval.resolved', (payload) => {
      if (state.agent.pendingApproval?.id === payload?.id) {
        state.updateAgent({ pendingApproval: null });
        refreshDisplay();
      }
    });

    clearInterval(ledAnimTimer);
    ledAnimTimer = setInterval(() => { ledAnimFrame++; updateLeds(); }, 500);

    client.connect();
  }

  function approveExec() {
    const a = state.agent.pendingApproval;
    if (!a || !client) return;
    client.rpc('exec.approval.resolve', { id: a.id, decision: 'allow-once' })
      .then(() => { state.updateAgent({ pendingApproval: null }); state.addAgentLine('lifecycle', '\u2713 Approved'); refreshDisplay(); })
      .catch((e) => log.error(`Approve: ${e.message}`));
  }

  function denyExec() {
    const a = state.agent.pendingApproval;
    if (!a || !client) return;
    client.rpc('exec.approval.resolve', { id: a.id, decision: 'deny' })
      .then(() => { state.updateAgent({ pendingApproval: null }); state.addAgentLine('lifecycle', '\u2717 Denied'); refreshDisplay(); })
      .catch((e) => log.error(`Deny: ${e.message}`));
  }

  // ---------------------------------------------------------------------------
  // Display rendering
  // ---------------------------------------------------------------------------

  function refreshDisplay() {
    const d = displayInstance;
    if (!d) return;

    try {
      if (!state.connected) {
        d.status?.set('CONNECTING...');
        d.line1?.set('');
        d.line2?.set('Set gateway token');
        d.line3?.set('in plugin settings');
        d.footer?.set('');
        return;
      }

      if (state.currentPage === 'agent') {
        renderAgentPage(d);
      } else if (state.currentPage === 'channels') {
        renderChannelsPage(d);
      }
    } catch (err) {
      log.error(`Render: ${err.message}`);
    }
  }

  function renderAgentPage(d) {
    const { agent } = state;
    const hasApproval = !!agent.pendingApproval;

    // Status text with mood
    const statusMap = {
      idle: 'IDLE',
      running: 'RUNNING',
      thinking: 'THINKING...',
      talking: 'RESPONDING...',
      working: 'USING TOOL...',
      error: 'ERROR',
    };
    d.status?.set(hasApproval ? '\u26a0 APPROVE?' : (statusMap[agent.status] || 'IDLE'));

    // Streaming text — last 3 lines
    const offset = agent._scrollOffset || 0;
    const visible = agent.lines.slice(
      Math.max(0, agent.lines.length - 3 - offset),
      agent.lines.length - offset
    );

    const lineIds = ['line1', 'line2', 'line3'];
    for (let i = 0; i < 3; i++) {
      const line = visible[i];
      d[lineIds[i]]?.set(line ? truncate(line.text, 20) : (i === 0 && visible.length === 0 ? 'Waiting...' : ''));
    }

    // Footer
    if (hasApproval) {
      d.footer?.set('\u25c0 YES        NO \u25b6');
    } else {
      d.footer?.set('\u25c0 prev    next \u25b6');
    }
  }

  function renderChannelsPage(d) {
    d.status?.set('CHANNELS');
    d.line1?.set('Loading...');
    d.line2?.set('');
    d.line3?.set('');
    d.footer?.set('\u25c0 prev    next \u25b6');

    if (!client) return;
    client.rpc('channels.status', {}).then((result) => {
      const accounts = result?.channelAccounts || {};
      const labels = result?.channelLabels || {};
      const order = result?.channelOrder || Object.keys(accounts);
      const lines = [];
      for (const ch of order) {
        for (const acct of (accounts[ch] || [])) {
          const dot = acct.connected ? '\u25cf' : '\u25cb';
          lines.push(`${dot} ${truncate(labels[ch] || ch, 10)}`);
        }
      }
      const ok = lines.filter(l => l.includes('\u25cf')).length;
      d.status?.set(`CHANNELS ${ok}/${lines.length}`);
      for (let i = 0; i < 3; i++) {
        d[['line1', 'line2', 'line3'][i]]?.set(lines[i] || '');
      }
    }).catch(() => {
      d.line1?.set('Error');
    });
  }

  // ---------------------------------------------------------------------------
  // LEDs
  // ---------------------------------------------------------------------------

  function updateLeds() {
    if (!ledInstance) return;
    const n = ledInstance.numberOfLeds || 8;
    const { agent } = state;
    let colors;

    if (agent.pendingApproval) {
      const on = ledAnimFrame % 2 === 0;
      colors = Array(n).fill(on ? `${COLORS.amber}FF` : '#00000000');
    } else if (agent.status === 'thinking') {
      const b = ledAnimFrame % 2 === 0 ? 'FF' : '44';
      colors = Array(n).fill(`#9944FF${b}`);
    } else if (agent.status === 'talking' || agent.status === 'running') {
      const b = ledAnimFrame % 2 === 0 ? 'FF' : '66';
      colors = Array(n).fill(`${COLORS.blue}${b}`);
    } else if (agent.status === 'working') {
      const b = ledAnimFrame % 2 === 0 ? 'FF' : '66';
      colors = Array(n).fill(`${COLORS.amber}${b}`);
    } else if (agent.status === 'error') {
      colors = Array(n).fill(`${COLORS.red}FF`);
    } else {
      colors = Array(n).fill(`${COLORS.green}FF`);
    }

    try { ledInstance.set(colors); } catch {}
  }
};

module.exports = openclawPlugin;
