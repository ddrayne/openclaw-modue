const { OpenClawClient } = require('./lib/ws-client');
const { State } = require('./lib/state');
const { COLORS, truncate, timeAgo, agentLineColor } = require('./lib/renderer');

const openclawPlugin = (configuration, storage, log) => {
  const state = new State();
  let client = null;
  let displayInstance = null;
  let ledInstance = null;
  let ledAnimFrame = 0;
  let ledAnimTimer = null;

  // ---------------------------------------------------------------------------
  // Global configuration — persists across restarts via storage
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
  // Display — 2x2 tile, ~114x114 usable area
  // Static layout with named text elements updated via instance.<id>.setText()
  // ---------------------------------------------------------------------------
  configuration
    .registerDisplay({ name: 'OpenClaw' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer
        .setMargin(3, 3, 3, 3)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row
      layer.addRow((row) => {
        row.setSize(108, 18).setBackgroundColor(COLORS.header);
        row.addDisplayText('page', (t) =>
          t.setText('OPENCLAW')
            .setColor(COLORS.white)
            .setFontSize(9)
            .setFontWeight('bold')
            .setMargin(4, 4, 0, 4)
        );
        row.addDisplayText('status', (t) =>
          t.setText('...')
            .setColor(COLORS.textDim)
            .setFontSize(8)
            .setTextAlign('right')
            .setMargin(5, 4, 0, 0)
        );
      });

      // Content line 1
      layer.addRow((row) => {
        row.setSize(108, 20).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line1', (t) =>
          t.setText('Connecting...')
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setMargin(4, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Content line 2
      layer.addRow((row) => {
        row.setSize(108, 20).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('line2', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(9)
            .setMargin(4, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Content line 3
      layer.addRow((row) => {
        row.setSize(108, 20).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line3', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(9)
            .setMargin(4, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Content line 4 / footer
      layer.addRow((row) => {
        row.setSize(108, 20).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('line4', (t) =>
          t.setText('\u25c0 prev    next \u25b6')
            .setColor(COLORS.textDim)
            .setFontSize(8)
            .setTextAlign('center')
            .setMargin(5, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
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
      // Scroll agent text buffer
      if (state.currentPage === 'agent') {
        const maxScroll = Math.max(0, state.agent.lines.length - 4);
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
  // Connection & events
  // ---------------------------------------------------------------------------

  function initConnection() {
    const url = storage.get('gatewayUrl') || 'ws://127.0.0.1:18789';
    const token = storage.get('gatewayToken') || '';

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
          state.addAgentLine('lifecycle', 'Run completed');
        } else if (evt.data?.phase === 'error') {
          state.updateAgent({ status: 'error' });
          state.addAgentLine('error', `Error: ${truncate(String(evt.data?.error), 35)}`);
        }
      } else if (evt.stream === 'thinking') {
        const text = evt.data?.thinking || evt.data?.delta || '';
        if (text) {
          const lastLine = text.split('\n').pop();
          state.addAgentLine('thinking', truncate(lastLine, 40));
        }
      } else if (evt.stream === 'assistant') {
        const delta = evt.data?.delta || '';
        if (delta) {
          const lines = state.agent.lines;
          const last = lines[lines.length - 1];
          if (last && last.type === 'assistant') {
            last.text = truncate(last.text + delta, 100);
          } else {
            state.addAgentLine('assistant', delta);
          }
        }
      } else if (evt.stream === 'tool') {
        if (evt.data?.phase === 'start') {
          state.addAgentLine('tool', `\u{1f527} ${evt.data?.name || 'tool'}`);
        } else if (evt.data?.phase === 'end') {
          state.addAgentLine('tool-end', '  \u2713 done');
        }
      }
      refreshDisplay();
    });

    client.on('exec.approval.requested', (payload) => {
      if (!payload) return;
      state.updateAgent({
        pendingApproval: {
          id: payload.id,
          command: payload.request?.command || 'unknown',
          expiresAtMs: payload.expiresAtMs,
        }
      });
      state.addAgentLine('approval', `\u26a0 APPROVE? ${truncate(payload.request?.command, 30)}`);
      refreshDisplay();
    });

    client.on('exec.approval.resolved', (payload) => {
      if (state.agent.pendingApproval?.id === payload?.id) {
        state.updateAgent({ pendingApproval: null });
        refreshDisplay();
      }
    });

    // LED animation
    clearInterval(ledAnimTimer);
    ledAnimTimer = setInterval(() => { ledAnimFrame++; updateLeds(); }, 500);

    client.connect();
  }

  function approveExec() {
    const approval = state.agent.pendingApproval;
    if (!approval || !client) return;
    client.rpc('exec.approval.resolve', { id: approval.id, decision: 'allow-once' })
      .then(() => {
        state.updateAgent({ pendingApproval: null });
        state.addAgentLine('lifecycle', '\u2713 Approved');
        refreshDisplay();
      })
      .catch((err) => log.error(`Approve failed: ${err.message}`));
  }

  function denyExec() {
    const approval = state.agent.pendingApproval;
    if (!approval || !client) return;
    client.rpc('exec.approval.resolve', { id: approval.id, decision: 'deny' })
      .then(() => {
        state.updateAgent({ pendingApproval: null });
        state.addAgentLine('lifecycle', '\u2717 Denied');
        refreshDisplay();
      })
      .catch((err) => log.error(`Deny failed: ${err.message}`));
  }

  // ---------------------------------------------------------------------------
  // Display updates — sets text on pre-registered elements
  // ---------------------------------------------------------------------------

  function refreshDisplay() {
    if (!displayInstance) return;
    try {
      if (state.currentPage === 'agent') {
        renderAgentPage();
      } else if (state.currentPage === 'channels') {
        renderChannelsPage();
      }
    } catch (err) {
      log.error(`Render error: ${err.message}`);
    }
  }

  function renderAgentPage() {
    const d = displayInstance;
    const { agent } = state;
    const hasApproval = !!agent.pendingApproval;

    d.page?.set('AGENT');
    d.status?.set(agent.status.toUpperCase());

    // Content lines — show last 3 lines from the buffer
    const offset = agent._scrollOffset || 0;
    const visible = agent.lines.slice(
      Math.max(0, agent.lines.length - 3 - offset),
      agent.lines.length - offset
    );

    const lineIds = ['line1', 'line2', 'line3'];
    for (let i = 0; i < 3; i++) {
      const line = visible[i];
      d[lineIds[i]]?.set(line ? truncate(line.text, 25) : '');
    }

    d.line4?.set(hasApproval ? '\u25c0 APPROVE    DENY \u25b6' : '\u25c0 prev    next \u25b6');
  }

  function renderChannelsPage() {
    const d = displayInstance;
    d.page?.set('CHANNELS');
    d.status?.set('');
    d.line1?.set('Fetching...');
    d.line2?.set('');
    d.line3?.set('');
    d.line4?.set('\u25c0 prev    next \u25b6');

    if (!client) return;
    client.rpc('channels.status', {}).then((result) => {
      const accounts = result?.channelAccounts || {};
      const labels = result?.channelLabels || {};
      const order = result?.channelOrder || Object.keys(accounts);
      const lines = [];
      for (const ch of order) {
        for (const acct of (accounts[ch] || [])) {
          const dot = acct.connected ? '\u25cf' : '\u25cb';
          const name = labels[ch] || ch;
          lines.push(`${dot} ${truncate(name, 10)} ${acct.connected ? 'ok' : 'off'}`);
        }
      }
      d.status?.set(`${lines.filter(l => l.includes('\u25cf')).length}/${lines.length}`);
      const lineIds = ['line1', 'line2', 'line3'];
      for (let i = 0; i < 3; i++) {
        d[lineIds[i]]?.set(lines[i] || '');
      }
    }).catch((err) => {
      d.line1?.set(`Error: ${truncate(err.message, 20)}`);
    });
  }

  // ---------------------------------------------------------------------------
  // LEDs
  // ---------------------------------------------------------------------------

  function updateLeds() {
    if (!ledInstance) return;
    const numLeds = ledInstance.numberOfLeds || 8;
    const { agent } = state;
    let colors;

    if (agent.pendingApproval) {
      const on = ledAnimFrame % 2 === 0;
      colors = Array(numLeds).fill(on ? `${COLORS.amber}FF` : '#00000000');
    } else if (agent.status === 'running') {
      const brightness = ledAnimFrame % 2 === 0 ? 'FF' : '66';
      colors = Array(numLeds).fill(`${COLORS.blue}${brightness}`);
    } else if (agent.status === 'error') {
      colors = Array(numLeds).fill(`${COLORS.red}FF`);
    } else {
      colors = Array(numLeds).fill(`${COLORS.green}FF`);
    }

    try { ledInstance.set(colors); } catch {}
  }
};

module.exports = openclawPlugin;
