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
  // Keys
  // -------------------------------------------------------------------------
  configuration
    .registerKey({ name: 'Approve / Prev' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      if (conn.pendingApproval) {
        conn.approveExec();
      } else {
        log.info('Prev pressed (no pending approval)');
      }
    });

  configuration
    .registerKey({ name: 'Deny / Next' })
    .registerOnKeyDownHandler(() => {
      const conn = Connection.getInstance(storage, log);
      if (conn.pendingApproval) {
        conn.denyExec();
      } else {
        log.info('Next pressed (no pending approval)');
      }
    });

  configuration
    .registerKey({ name: 'Talk' })
    .registerOnKeyDownHandler(() => {
      log.info('Talk pressed');
    });

  // -------------------------------------------------------------------------
  // Knob
  // -------------------------------------------------------------------------
  configuration
    .registerKnob({ name: 'Scroll' })
    .registerOnChangeHandler((value) => {
      log.info(`Scroll: ${value}`);
    });

  // -------------------------------------------------------------------------
  // LEDs
  // -------------------------------------------------------------------------
  let ledInstance = null;
  let ledAnimFrame = 0;
  let ledAnimTimer = null;

  configuration
    .registerLedCluster({ name: 'Status' })
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
