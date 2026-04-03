const { OpenClawClient } = require('./lib/ws-client');
const { State } = require('./lib/state');
const { COLORS } = require('./lib/renderer');
const { AgentLivePage } = require('./lib/pages/agent-live');
const { ChannelsPage } = require('./lib/pages/channels');
const { SessionsPage } = require('./lib/pages/sessions');
const { CommandsPage } = require('./lib/pages/commands');

const DISPLAY_W = 240; // 2-row display width
const DISPLAY_H = 120; // 2-row display height

const openclawPlugin = (configuration, storage, log) => {
  // ---------------------------------------------------------------------------
  // State & client
  // ---------------------------------------------------------------------------
  const state = new State();
  let client = null;
  let pages = {};
  let currentPageObj = null;
  let displayInstance = null;
  let ledInstance = null;

  // LED animation state
  let ledAnimFrame = 0;
  let ledAnimTimer = null;

  // ---------------------------------------------------------------------------
  // Configuration — gateway URL and token
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
    )
    .addInput(
      { key: 'cmd1Label', name: 'Command 1 - Label' },
      'string',
    )
    .addDropdown({
      key: 'cmd1Action',
      name: 'Command 1 - Action',
      source: () => [
        { label: 'Trigger Cron Job', value: 'cron.run' },
        { label: 'Send Agent Message', value: 'agent' },
        { label: 'Health Check', value: 'health' },
        { label: 'Tail Logs', value: 'logs.tail' },
      ],
    })
    .addInput(
      { key: 'cmd1Param', name: 'Command 1 - Parameter', description: 'Cron job ID or message text' },
      'string',
    )
    .addInput({ key: 'cmd2Label', name: 'Command 2 - Label' }, 'string')
    .addDropdown({
      key: 'cmd2Action',
      name: 'Command 2 - Action',
      source: () => [
        { label: 'Trigger Cron Job', value: 'cron.run' },
        { label: 'Send Agent Message', value: 'agent' },
        { label: 'Health Check', value: 'health' },
        { label: 'Tail Logs', value: 'logs.tail' },
      ],
    })
    .addInput(
      { key: 'cmd2Param', name: 'Command 2 - Parameter', description: 'Cron job ID or message text' },
      'string',
    )
    .addInput({ key: 'cmd3Label', name: 'Command 3 - Label' }, 'string')
    .addDropdown({
      key: 'cmd3Action',
      name: 'Command 3 - Action',
      source: () => [
        { label: 'Trigger Cron Job', value: 'cron.run' },
        { label: 'Send Agent Message', value: 'agent' },
        { label: 'Health Check', value: 'health' },
        { label: 'Tail Logs', value: 'logs.tail' },
      ],
    })
    .addInput(
      { key: 'cmd3Param', name: 'Command 3 - Parameter', description: 'Cron job ID or message text' },
      'string',
    );

  // ---------------------------------------------------------------------------
  // Display widget — max 2 rows (setSize takes columns, rows)
  // ---------------------------------------------------------------------------
  configuration
    .registerDisplay({ name: 'OpenClaw' })
    .setSize(2, 2)
    .addLayer((layer) => {
      // Initial "connecting" screen
      layer.setBackgroundColor(COLORS.bg);
      layer.addRow((row) => {
        row.setSize(DISPLAY_W, 18).setBackgroundColor(COLORS.header);
        row.addDisplayText('boot-title', (t) =>
          t.setText('OPENCLAW')
            .setColor(COLORS.white)
            .setFontSize(12)
            .setFontWeight('bold')
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
      layer.addRow((row) => {
        row.setSize(DISPLAY_W, 40).setBackgroundColor(COLORS.bg);
        row.addDisplayText('boot-msg', (t) =>
          t.setText('Connecting to gateway...')
            .setColor(COLORS.textDim)
            .setFontSize(10)
            .setTextAlign('center')
            .setMargin(12, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      displayInstance = instance;
      log.info('Display initialized');
      initConnection(instance);
    })
    .registerOnConfigurationChangeHandler((prop, instance) => {
      log.info(`Config changed: ${prop.key} = ${JSON.stringify(prop.value)}`);
      if (prop.key === 'gatewayUrl' || prop.key === 'gatewayToken') {
        // Reconnect with new credentials
        if (client) client.disconnect();
        initConnection(instance);
      }
      if (prop.key.startsWith('cmd')) {
        syncCommandSlots(instance);
      }
    })
    .registerOnDeactivateHandler(() => {
      if (client) client.disconnect();
      clearInterval(ledAnimTimer);
      log.info('Display deactivated');
    });

  // ---------------------------------------------------------------------------
  // Keys — Page nav (prev/next) + context-sensitive actions
  // ---------------------------------------------------------------------------
  configuration
    .registerKey({ name: 'Prev Page / Approve' })
    .registerOnInitializeHandler((instance) => {
      log.info(`Key PrevPage/Approve initialized: ${instance.id}`);
    })
    .registerOnKeyDownHandler(() => {
      if (state.currentPage === 'agent') {
        // On agent page: Approve button
        if (state.agent.pendingApproval) {
          pages.agent?.onApprove();
          return;
        }
      }
      if (state.currentPage === 'sessions' && state.sessions.detailView) {
        pages.sessions?.onWatch();
        return;
      }
      // Default: previous page
      switchPage(state.prevPage());
    });

  configuration
    .registerKey({ name: 'Next Page / Deny' })
    .registerOnInitializeHandler((instance) => {
      log.info(`Key NextPage/Deny initialized: ${instance.id}`);
    })
    .registerOnKeyDownHandler(() => {
      if (state.currentPage === 'agent') {
        // On agent page: Deny button
        if (state.agent.pendingApproval) {
          pages.agent?.onDeny();
          return;
        }
      }
      if (state.currentPage === 'sessions' && state.sessions.detailView) {
        pages.sessions?.onBack();
        return;
      }
      // Default: next page
      switchPage(state.nextPage());
    });

  configuration
    .registerKey({ name: 'Action / Select' })
    .registerOnInitializeHandler((instance) => {
      log.info(`Key Action/Select initialized: ${instance.id}`);
    })
    .registerOnKeyDownHandler(() => {
      if (state.currentPage === 'sessions') {
        pages.sessions?.onSelect();
      } else if (state.currentPage === 'channels') {
        pages.channels?.onToggle();
      } else if (state.currentPage === 'commands') {
        // Use knob position to determine which slot
        // For now, fire slot 0
        pages.commands?.onKey(0);
      }
      refreshDisplay();
    });

  // Command slot keys (1-5)
  for (let i = 0; i < 5; i++) {
    configuration
      .registerKey({ name: `Cmd ${i + 1}` })
      .registerOnKeyDownHandler(() => {
        if (state.currentPage === 'commands') {
          pages.commands?.onKey(i);
        }
        refreshDisplay();
      });
  }

  // ---------------------------------------------------------------------------
  // Knob — context-sensitive scrolling
  // ---------------------------------------------------------------------------
  configuration
    .registerKnob({ name: 'Scroll / Navigate' })
    .registerOnInitializeHandler((instance) => {
      log.info(`Knob initialized: ${instance.id}`);
    })
    .registerOnChangeHandler((value) => {
      const page = pages[state.currentPage];
      if (page && typeof page.onScroll === 'function') {
        page.onScroll(value);
      }
      refreshDisplay();
    });

  // ---------------------------------------------------------------------------
  // LED cluster — status indicator
  // ---------------------------------------------------------------------------
  configuration
    .registerLedCluster({ name: 'Status LEDs' })
    .registerOnInitializeHandler((instance) => {
      ledInstance = instance;
      log.info(`LED cluster initialized with ${instance.numberOfLeds} LEDs`);
      updateLeds();
    })
    .registerOnDeactivateHandler(() => {
      ledInstance = null;
    });

  // ---------------------------------------------------------------------------
  // Internal functions
  // ---------------------------------------------------------------------------

  function initConnection(instance) {
    const url = instance?.configuration?.gatewayUrl
      || storage.get('gatewayUrl')
      || 'ws://127.0.0.1:18789';
    const token = instance?.configuration?.gatewayToken
      || storage.get('gatewayToken')
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || '';

    if (!token) {
      log.warn('No gateway token configured. Set it in plugin settings.');
    }

    client = new OpenClawClient(url, token, log);

    // Initialize pages
    pages = {
      agent: new AgentLivePage(state, client, log),
      channels: new ChannelsPage(state, client, log),
      sessions: new SessionsPage(state, client, log),
      commands: new CommandsPage(state, client, log, storage),
    };

    // Listen for connection state
    client.on('connection', (info) => {
      state.update({ connected: info.connected });
      if (info.connected) {
        log.info('Connected — activating agent page');
        switchPage('agent');
        syncCommandSlots(instance);
      }
      refreshDisplay();
    });

    // State change triggers re-render
    state.setOnChange(() => {
      refreshDisplay();
      updateLeds();
    });

    // Start LED animation timer
    clearInterval(ledAnimTimer);
    ledAnimTimer = setInterval(() => {
      ledAnimFrame++;
      updateLeds();
    }, 500);

    client.connect();
  }

  function switchPage(pageName) {
    // Deactivate current page
    if (currentPageObj && typeof currentPageObj.deactivate === 'function') {
      currentPageObj.deactivate();
    }
    state.currentPage = pageName;
    currentPageObj = pages[pageName];
    if (currentPageObj && typeof currentPageObj.activate === 'function') {
      currentPageObj.activate();
    }
    refreshDisplay();
  }

  function refreshDisplay() {
    if (!displayInstance) return;

    const page = pages[state.currentPage];
    if (!page) return;

    // The Modue display API uses a builder pattern — we rebuild the display
    // content each time by calling render on the current page.
    // Since the display was registered with addLayer, we update it by
    // re-rendering. The Modue SDK handles the diff.
    try {
      displayInstance.clearLayers?.();
      displayInstance.addLayer?.((layer) => {
        layer.setBackgroundColor(COLORS.bg);

        if (!state.connected) {
          layer.addRow((row) => {
            row.setSize(DISPLAY_W, 18).setBackgroundColor(COLORS.header);
            row.addDisplayText('dc-title', (t) =>
              t.setText('OPENCLAW')
                .setColor(COLORS.white)
                .setFontSize(12)
                .setFontWeight('bold')
                .setTextAlign('center')
                .setMargin(3, 0, 0, 0)
            );
          });
          layer.addRow((row) => {
            row.setSize(DISPLAY_W, 40).setBackgroundColor(COLORS.bg);
            row.addDisplayText('dc-msg', (t) =>
              t.setText('Connecting...')
                .setColor(COLORS.amber)
                .setFontSize(10)
                .setTextAlign('center')
                .setMargin(12, 0, 0, 0)
            );
          });
          return;
        }

        page.render(layer, DISPLAY_W, DISPLAY_H);
      });
    } catch (err) {
      log.error(`Render error: ${err.message}`);
    }
  }

  function updateLeds() {
    if (!ledInstance) return;

    const page = pages[state.currentPage];
    const ledData = page?.getLedColors?.() || 'dim';
    const numLeds = ledInstance.numberOfLeds || 8;

    let colors;
    if (Array.isArray(ledData)) {
      // Direct color array from page
      colors = Array.from({ length: numLeds }, (_, i) => ledData[i] || COLORS.textDim);
    } else if (ledData === 'green') {
      colors = Array(numLeds).fill(`${COLORS.green}FF`);
    } else if (ledData === 'red') {
      colors = Array(numLeds).fill(`${COLORS.red}FF`);
    } else if (ledData === 'blue-pulse') {
      const brightness = ledAnimFrame % 2 === 0 ? 'FF' : '66';
      colors = Array(numLeds).fill(`${COLORS.blue}${brightness}`);
    } else if (ledData === 'amber-flash') {
      const on = ledAnimFrame % 2 === 0;
      colors = Array(numLeds).fill(on ? `${COLORS.amber}FF` : '#00000000');
    } else {
      // dim
      colors = Array(numLeds).fill(`${COLORS.textDim}44`);
    }

    try {
      ledInstance.set(colors);
    } catch (err) {
      log.error(`LED error: ${err.message}`);
    }
  }

  function syncCommandSlots(instance) {
    if (!instance?.configuration) return;
    const slots = [];
    for (let i = 1; i <= 3; i++) {
      const label = instance.configuration[`cmd${i}Label`];
      const action = instance.configuration[`cmd${i}Action`];
      const param = instance.configuration[`cmd${i}Param`];
      if (label && action) {
        slots.push({
          label,
          actionType: action,
          params: action === 'cron.run'
            ? { jobId: param }
            : action === 'agent'
            ? { message: param }
            : {},
        });
      }
    }
    pages.commands?.saveSlots(slots);
  }
};

module.exports = openclawPlugin;
