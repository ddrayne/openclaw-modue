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
      conn.sendSliderChanged(value);
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
      } else {
        conn.rpc('modue.key.pressed', { key: 'left' }).catch(() => {});
      }
    });

  configuration
    .registerKey({ name: 'Right' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      if (conn.pendingApproval) {
        conn.denyExec();
      } else {
        conn.rpc('modue.key.pressed', { key: 'right' }).catch(() => {});
      }
    });

  configuration
    .registerKey({ name: 'Center' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      conn.rpc('modue.key.pressed', { key: 'center' }).catch(() => {});
    });

  // -------------------------------------------------------------------------
  // Knob
  // -------------------------------------------------------------------------
  configuration
    .registerKnob({ name: 'Scroll' })
    .registerOnChangeHandler((value) => {
      const conn = Connection.getInstance(storage, log);
      conn.rpc('modue.knob.changed', { value }).catch(() => {});
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
