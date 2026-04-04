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
  // Configuration
  // ---------------------------------------------------------------------------
  configuration
    .useConfiguration()
    .addInput(
      { key: 'gatewayUrl', name: 'Gateway URL', description: 'OpenClaw WebSocket URL' },
      'string',
    )
    .addInput(
      { key: 'gatewayToken', name: 'Gateway Token', description: 'OPENCLAW_GATEWAY_TOKEN value' },
      'password',
    );

  // ---------------------------------------------------------------------------
  // Display — static layout, updated via instance.<id>.setText()
  // ---------------------------------------------------------------------------
  configuration
    .registerDisplay({ name: 'OpenClaw' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer
        .setMargin(2, 2, 2, 2)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Row 1: Header bar
      layer.addRow((row) => {
        row.setSize(116, 20).setBackgroundColor(COLORS.header);
        row.addDisplayText('page', (t) =>
          t.setText('OPENCLAW')
            .setColor(COLORS.white)
            .setFontSize(10)
            .setFontWeight('bold')
            .setMargin(4, 4, 0, 4)
        );
        row.addDisplayText('status', (t) =>
          t.setText('...')
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setTextAlign('right')
            .setMargin(5, 4, 0, 0)
        );
      });

      // Row 2: Main content line 1
      layer.addRow((row) => {
        row.setSize(116, 18).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line1', (t) =>
          t.setText('Connecting...')
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setMargin(3, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Row 3: Main content line 2
      layer.addRow((row) => {
        row.setSize(116, 18).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('line2', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(9)
            .setMargin(3, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Row 4: Main content line 3
      layer.addRow((row) => {
        row.setSize(116, 18).setBackgroundColor(COLORS.bg);
        row.addDisplayText('line3', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(9)
            .setMargin(3, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Row 5: Main content line 4
      layer.addRow((row) => {
        row.setSize(116, 18).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('line4', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setMargin(3, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Row 6: Footer
      layer.addRow((row) => {
        row.setSize(116, 16).setBackgroundColor(COLORS.black);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(8)
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      displayInstance = instance;
      log.info('Display initialized');
      initConnection(instance);
    })
    .registerOnConfigurationChangeHandler((prop, instance) => {
      if (prop.key === 'gatewayUrl' || prop.key === 'gatewayToken') {
        if (client) client.disconnect();
        initConnection(instance);
      }
    })
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

  function initConnection(instance) {
    const url = instance?.configuration?.gatewayUrl
      || storage.get('gatewayUrl')
      || 'ws://127.0.0.1:18789';
    const token = instance?.configuration?.gatewayToken
      || storage.get('gatewayToken')
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || '';

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

    // Header
    d.page?.setText('AGENT');
    d.page?.setColor(COLORS.white);
    d.status?.setText(agent.status.toUpperCase());
    d.status?.setColor(
      agent.status === 'running' ? COLORS.blue
      : agent.status === 'error' ? COLORS.red
      : COLORS.green
    );

    // Content lines — show last 4 lines from the buffer
    const offset = agent._scrollOffset || 0;
    const visible = agent.lines.slice(
      Math.max(0, agent.lines.length - 4 - offset),
      agent.lines.length - offset
    );

    const lineIds = ['line1', 'line2', 'line3', 'line4'];
    for (let i = 0; i < 4; i++) {
      const line = visible[i];
      d[lineIds[i]]?.setText(line ? truncate(line.text, 30) : '');
      d[lineIds[i]]?.setColor(line ? agentLineColor(line.type) : COLORS.textDim);
    }

    // Footer
    if (hasApproval) {
      d.footer?.setText('\u25c0 APPROVE    DENY \u25b6');
      d.footer?.setColor(COLORS.amber);
    } else {
      d.footer?.setText('\u25c0 prev    next \u25b6');
      d.footer?.setColor(COLORS.textDim);
    }
  }

  function renderChannelsPage() {
    const d = displayInstance;
    d.page?.setText('CHANNELS');
    d.status?.setText('');
    d.line1?.setText('Fetching...');
    d.line1?.setColor(COLORS.textDim);
    d.line2?.setText('');
    d.line3?.setText('');
    d.line4?.setText('');
    d.footer?.setText('\u25c0 prev    next \u25b6');
    d.footer?.setColor(COLORS.textDim);

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
          lines.push(`${dot} ${truncate(name, 12)} ${acct.connected ? 'ok' : acct.lastError ? 'err' : 'off'}`);
        }
      }
      d.status?.setText(`${lines.filter(l => l.includes('\u25cf')).length}/${lines.length}`);
      const lineIds = ['line1', 'line2', 'line3', 'line4'];
      for (let i = 0; i < 4; i++) {
        d[lineIds[i]]?.setText(lines[i] || '');
        d[lineIds[i]]?.setColor(lines[i]?.includes('\u25cf') ? COLORS.green : COLORS.textDim);
      }
    }).catch((err) => {
      d.line1?.setText(`Error: ${truncate(err.message, 25)}`);
      d.line1?.setColor(COLORS.red);
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
