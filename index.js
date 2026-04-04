const { OpenClawClient } = require('./lib/ws-client');
const { State } = require('./lib/state');
const { COLORS, truncate, agentLineColor } = require('./lib/renderer');

const openclawPlugin = (configuration, storage, log) => {
  const state = new State();
  let client = null;
  let displayInstance = null;
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
  // Display — 2x4 tile (120x240px) — tall layout with lots of room
  //
  // Header:  30px — lobster + status
  // Lines:   7 x 26px = 182px — streaming text
  // Footer:  22px — nav controls
  // Total:   234px (fits in 240px with 4px margins)
  // ---------------------------------------------------------------------------
  configuration
    .registerDisplay({ name: 'OpenClaw' })
    .setSize(2, 4)
    .addLayer((layer) => {
      layer
        .setMargin(3, 3, 3, 3)
        .setBorderRadius(6, 6, 6, 6)
        .setBackgroundColor(COLORS.bg);

      // --- Header: lobster + status ---
      layer.addRow((row) => {
        row.setSize(114, 30).setBackgroundColor(COLORS.header);

        row.addColumn((col) => {
          col.setSize(30, 30);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(20)
              .setTextAlign('center')
              .setMargin(3, 0, 0, 2)
          );
        });

        row.addColumn((col) => {
          col.setSize(84, 30);
          col.addDisplayText('status', (t) =>
            t.setText('CONNECTING')
              .setColor(COLORS.amber)
              .setFontSize(18)
              .setFontWeight('bold')
              .setMargin(5, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // --- 7 content lines ---
      for (let i = 1; i <= 7; i++) {
        layer.addRow((row) => {
          row.setSize(114, 26).setBackgroundColor(i % 2 === 0 ? COLORS.bgAlt : COLORS.bg);
          row.addDisplayText(`line${i}`, (t) =>
            t.setText('')
              .setColor(COLORS.text)
              .setFontSize(16)
              .setMargin(4, 6, 0, 6)
              .setTextWrap('ellipsis')
          );
        });
      }

      // --- Footer ---
      layer.addRow((row) => {
        row.setSize(114, 22).setBackgroundColor(COLORS.black);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(13)
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
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
      if (state.currentPage === 'agent') {
        const maxScroll = Math.max(0, state.agent.lines.length - 7);
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

    if (client) client.disconnect();
    client = new OpenClawClient(url, token, log);

    client.on('connection', (info) => {
      state.update({ connected: info.connected });
      if (info.connected) {
        state.addAgentLine('lifecycle', 'Connected');
      }
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
        pendingApproval: { id: payload.id, command: payload.request?.command || '?', expiresAtMs: payload.expiresAtMs }
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
  // Display rendering — uses .set() on components
  // ---------------------------------------------------------------------------

  function refreshDisplay() {
    const d = displayInstance;
    if (!d) return;

    try {
      if (!state.connected) {
        d.status?.set('CONNECTING');
        d.line1?.set('');
        d.line2?.set('');
        d.line3?.set('Set gateway token');
        d.line4?.set('in plugin settings');
        d.line5?.set('then press Connect');
        d.line6?.set('');
        d.line7?.set('');
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

    const statusMap = {
      idle: 'IDLE',
      running: 'RUNNING',
      thinking: 'THINKING...',
      talking: 'RESPONDING',
      working: 'TOOL...',
      error: 'ERROR',
    };
    d.status?.set(hasApproval ? '\u26a0 APPROVE?' : (statusMap[agent.status] || 'IDLE'));

    // Show last 7 lines from the text buffer
    const offset = agent._scrollOffset || 0;
    const visible = agent.lines.slice(
      Math.max(0, agent.lines.length - 7 - offset),
      agent.lines.length - offset
    );

    for (let i = 1; i <= 7; i++) {
      const line = visible[i - 1];
      d[`line${i}`]?.set(line ? truncate(line.text, 18) : (i === 1 && visible.length === 0 ? 'Waiting...' : ''));
    }

    d.footer?.set(hasApproval ? '\u25c0 YES        NO \u25b6' : '\u25c0 prev    next \u25b6');
  }

  function renderChannelsPage(d) {
    d.status?.set('CHANNELS');
    d.line1?.set('Loading...');
    for (let i = 2; i <= 7; i++) d[`line${i}`]?.set('');
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
          lines.push(`${dot} ${truncate(labels[ch] || ch, 14)}`);
        }
      }
      const ok = lines.filter(l => l.includes('\u25cf')).length;
      d.status?.set(`CHANNELS ${ok}/${lines.length}`);
      for (let i = 1; i <= 7; i++) {
        d[`line${i}`]?.set(lines[i - 1] || '');
      }
    }).catch(() => {
      d.line1?.set('Error loading');
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
