// OpenClaw plugin for Modue — multi-widget control surface
// 6 displays, 3 keys, 1 knob, 1 LED cluster

const { Connection } = require('./lib/connection');
const { registerWidgets } = require('./lib/widgets');

const openclawPlugin = (configuration, storage, log) => {
  // -------------------------------------------------------------------------
  // Global config
  // -------------------------------------------------------------------------
  configuration
    .useConfiguration()
    .addInput(
      { key: 'gatewayUrl', name: 'Gateway URL', description: 'Default: ws://127.0.0.1:18789' },
      'string',
    )
    .addInput(
      { key: 'gatewayToken', name: 'Gateway Token', description: 'OPENCLAW_GATEWAY_TOKEN' },
      'password',
    )
    .addButton({
      key: 'connectButton',
      name: 'Connect',
      renderer: () => {
        try {
          return Connection.getInstance().connected ? 'Connected' : 'Connect';
        } catch (_) {
          return 'Connect';
        }
      },
      handler: async () => {
        const conn = Connection.getInstance(storage, log);
        conn.connect();
      },
    });

  // -------------------------------------------------------------------------
  // Display widgets (6 total)
  // -------------------------------------------------------------------------
  registerWidgets(configuration, storage, log);

  // -------------------------------------------------------------------------
  // Slider
  // -------------------------------------------------------------------------
  configuration
    .registerSlider({ name: 'OpenClaw' })
    .registerOnInitializeHandler((instance) => {
      const conn = Connection.getInstance(storage, log);
      conn._sliderInstance = instance;
      if (!conn.connected && !conn._client) {
        conn.connect();
      }
    })
    .registerOnChangeHandler((value, _instance) => {
      const conn = Connection.getInstance(storage, log);
      // Use slider to scroll through response text
      conn.handleSliderScroll(value);
    })
    .registerOnDeactivateHandler(() => {
      try { Connection.getInstance()._sliderInstance = null; } catch (_) {}
    });

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------
  configuration
    .registerKey({ name: 'Left' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      if (conn.pendingApproval) {
        conn.approveExec();
        log.info('[key] Left: approved exec');
      } else if (conn.agentStatus === 'thinking' || conn.agentStatus === 'talking' || conn.agentStatus === 'working') {
        // Abort current generation
        conn.rpc('chat.abort', {}).then(() => {
          conn.displayText = '\u23F9 Aborted';
          conn._notify();
          log.info('[key] Left: aborted generation');
        }).catch((e) => log.error(`Abort failed: ${e.message}`));
      } else {
        // Wake the assistant
        conn.rpc('wake', { text: 'modue button pressed' }).catch(() => {});
        log.info('[key] Left: wake');
      }
    });

  configuration
    .registerKey({ name: 'Right' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      if (conn.pendingApproval) {
        conn.denyExec();
        log.info('[key] Right: denied exec');
      } else {
        // Quick status check — show usage/cost on display
        conn.rpc('usage.status', {}).then((r) => {
          const cost = r?.totalCost != null ? `\u00A3${r.totalCost.toFixed(2)}` : '';
          const tokens = r?.totalTokens != null ? `${Math.round(r.totalTokens / 1000)}k tokens` : '';
          const info = [cost, tokens].filter(Boolean).join(' \u2022 ');
          conn.displayText = info || 'No usage data';
          conn._notify();
          log.info(`[key] Right: usage = ${info}`);
        }).catch((e) => {
          conn.displayText = 'Could not fetch usage';
          conn._notify();
          log.error(`Usage fetch failed: ${e.message}`);
        });
      }
    });

  configuration
    .registerKey({ name: 'Center' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      // Toggle between showing channels and last activity
      conn.rpc('channels.status', {}).then((r) => {
        const accts = r?.channelAccounts || {};
        const labels = r?.channelLabels || {};
        const order = r?.channelOrder || Object.keys(accts);
        const lines = [];
        for (const ch of order) {
          for (const a of (accts[ch] || [])) {
            const name = labels[ch] || ch;
            const dot = a.connected ? '\u25CF' : '\u25CB';
            lines.push(`${dot} ${name}`);
          }
        }
        conn.displayText = lines.join('\n') || 'No channels';
        conn._notify();
        log.info(`[key] Center: channels = ${lines.length}`);
      }).catch((e) => {
        conn.displayText = 'Could not fetch channels';
        conn._notify();
        log.error(`Channels fetch failed: ${e.message}`);
      });
    });

  // -------------------------------------------------------------------------
  // Knob
  // -------------------------------------------------------------------------
  configuration
    .registerKnob({ name: 'Scroll' })
    .registerOnChangeHandler((value) => {
      // Knob currently unused — could map to model select or volume
    });

  // -------------------------------------------------------------------------
  // LEDs
  // -------------------------------------------------------------------------
  let ledInstance = null;
  let ledAnimFrame = 0;
  let ledAnimTimer = null;

  configuration
    .registerLedCluster({ name: 'Status' })
    .useSystemMonitorResources((resources, _instance) => {
      try {
        const conn = Connection.getInstance(storage, log);
        conn.updateSystemStats(resources);
      } catch (_) { /* noop */ }
    })
    .registerOnInitializeHandler((instance) => {
      ledInstance = instance;
      ledAnimFrame = 0;
      ledAnimTimer = setInterval(() => {
        ledAnimFrame++;
        if (!ledInstance) return;
        const conn = Connection.getInstance(storage, log);
        const n = ledInstance.numberOfLeds || 8;
        try {
          ledInstance.set(conn.getLedColors(n, ledAnimFrame));
        } catch (_) { /* noop */ }
      }, 500);
    })
    .registerOnDeactivateHandler(() => {
      if (ledAnimTimer) { clearInterval(ledAnimTimer); ledAnimTimer = null; }
      ledInstance = null;
    });
};

module.exports = openclawPlugin;
