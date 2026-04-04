// Display widgets for the OpenClaw plugin.
// Each widget subscribes to the Connection singleton for state updates.

const { Connection } = require('./connection');
const { COLORS } = require('./renderer');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Safely connect if not already connected or connecting.
 */
function ensureConnected(conn) {
  if (!conn.connected && !conn._client) {
    conn.connect();
  }
}

/**
 * Format the source line for display: "Dan via Telegram" or "via Telegram" or ""
 */
function formatSource(c) {
  const parts = [];
  if (c.sourceSender) parts.push(c.sourceSender);
  if (c.sourceChannel) {
    parts.push(parts.length ? `via ${c.sourceChannel}` : c.sourceChannel);
  }
  return parts.length ? '\u{1F4AC} ' + parts.join(' ') : '';
}

/**
 * Format the controls line: approval with risk indicator, or empty.
 */
function formatControls(c) {
  if (!c.pendingApproval) return '';
  const risk = c.pendingApproval.risk === 'HIGH' ? ' \u{1F6A8}' : '';
  return `\u25C0 YES${risk}    NO \u25B6`;
}

/**
 * Bind a Connection subscriber to a display instance's components.
 * Returns the unsubscribe function for use in deactivate handlers.
 */
function bindDisplay(conn, dc, updateFn) {
  // Run once immediately with current state
  try { updateFn(conn, dc); } catch (_) { /* noop */ }
  // Subscribe for future changes
  return conn.onChange((c) => {
    try { updateFn(c, dc); } catch (_) { /* noop */ }
  });
}

// ---------------------------------------------------------------------------
// Widget 1: Claw Status (1x1 = 120x120px, usable 112x112, setSize 56x56)
// ---------------------------------------------------------------------------

function registerClawStatus(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Status' })
    .setSize(1, 1)
    .addLayer((layer) => {
      layer
        .setMargin(2, 2, 2, 2)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Lobster icon row — 26px (renders 52px)
      layer.addRow((row) => {
        row.setSize(56, 26);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });

      // Status phrase row — 18px (renders 36px)
      layer.addRow((row) => {
        row.setSize(56, 18);
        row.addDisplayText('status', (t) =>
          t.setText('offline')
            .setColor(COLORS.textDim)
            .setFontSize(16)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Elapsed / detail row — 12px (renders 24px)
      layer.addRow((row) => {
        row.setSize(56, 12);
        row.addDisplayText('detail', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(12)
            .setTextAlign('center')
            .setMargin(0, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        d.detail?.set(c.statusDetail || '');
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 2: Claw Stream (2x2 = 240x240px, usable 228x228, setSize 114x114)
// ---------------------------------------------------------------------------

function registerClawStream(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Stream' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer
        .setMargin(3, 3, 3, 3)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 22px (renders 44px): emoji (19) + status (95)
      layer.addRow((row) => {
        row.setSize(114, 22).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(19, 22);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(20)
              .setTextAlign('center')
              .setMargin(6, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(95, 22);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(18)
              .setFontWeight('bold')
              .setMargin(8, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content row — 76px (renders 152px): wrapping text, big font
      layer.addRow((row) => {
        row.setSize(114, 78).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting...')
            .setColor(COLORS.text)
            .setFontSize(20)
            .setMargin(4, 4, 2, 4)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 16px (renders 32px): channel info
      layer.addRow((row) => {
        row.setSize(114, 16).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setMargin(4, 6, 0, 6)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        d.content?.set(c.displayText || 'Waiting...');
        d.channel?.set(formatSource(c));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 3: Claw Live (4x2 = 240x480px, usable 228x468, setSize 114x234)
//   Header: 24  |  Content: 186  |  Footer: 24  = 234
// ---------------------------------------------------------------------------

function registerClawLive(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Live' })
    .setSize(4, 2)
    .addLayer((layer) => {
      layer
        .setMargin(3, 3, 3, 3)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 28px (renders 56px): same proportions as Full
      layer.addRow((row) => {
        row.setSize(114, 28).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(20, 28);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(18)
              .setTextAlign('center')
              .setMargin(6, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(66, 28);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(14)
              .setFontWeight('bold')
              .setMargin(8, 2, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(28, 28);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(12)
              .setTextAlign('right')
              .setMargin(9, 3, 0, 0)
          );
        });
      });

      // Content row — 182px (renders 364px): readable text
      layer.addRow((row) => {
        row.setSize(114, 182).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(22)
            .setMargin(6, 5, 4, 5)
            .setTextWrap('wrap')
        );
      });

      // Footer — source + controls combined, 24px (renders 48px)
      layer.addRow((row) => {
        row.setSize(114, 24).setBackgroundColor(COLORS.black);
        row.addColumn((col) => {
          col.setSize(70, 24);
          col.addDisplayText('channel', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(14)
              .setMargin(8, 6, 0, 6)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(44, 24);
          col.addDisplayText('controls', (t) =>
            t.setText('')
              .setColor(COLORS.amber)
              .setFontSize(14)
              .setTextAlign('right')
              .setMargin(8, 6, 0, 0)
          );
        });
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        d.elapsed?.set(c.statusDetail || '');
        d.content?.set(c.displayText || 'Waiting for activity...');
        d.channel?.set(formatSource(c));
        d.controls?.set(formatControls(c));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 4: Claw Full (8x2 = 240x960px, usable 228x948, setSize 114x474)
// ---------------------------------------------------------------------------

function registerClawFull(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Full' })
    .setSize(8, 2)
    .addLayer((layer) => {
      layer
        .setMargin(3, 3, 3, 3)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header — 30px (renders 60px): breathing room so text isn't clipped
      layer.addRow((row) => {
        row.setSize(114, 30).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(20, 30);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(18)
              .setTextAlign('center')
              .setMargin(7, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(66, 30);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(14)
              .setFontWeight('bold')
              .setMargin(9, 2, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(28, 30);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(12)
              .setTextAlign('right')
              .setMargin(10, 3, 0, 0)
          );
        });
      });

      // Content row — 418px (renders 836px): sweet spot font size
      layer.addRow((row) => {
        row.setSize(114, 418).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(24)
            .setMargin(6, 5, 4, 5)
            .setTextWrap('wrap')
        );
      });

      // Footer — 26px (renders 52px): source + controls
      layer.addRow((row) => {
        row.setSize(114, 26).setBackgroundColor(COLORS.black);
        row.addColumn((col) => {
          col.setSize(70, 24);
          col.addDisplayText('channel', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(16)
              .setMargin(8, 6, 0, 6)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(44, 24);
          col.addDisplayText('controls', (t) =>
            t.setText('')
              .setColor(COLORS.amber)
              .setFontSize(16)
              .setTextAlign('right')
              .setMargin(8, 6, 0, 0)
          );
        });
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        d.elapsed?.set(c.statusDetail || '');
        d.content?.set(c.displayText || 'Waiting for activity...');
        d.channel?.set(formatSource(c));
        d.controls?.set(formatControls(c));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 5: Channels (2x1 = 120x240px, usable 112x232, setSize 56x116)
// ---------------------------------------------------------------------------

function registerChannels(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Channels' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer
        .setMargin(2, 2, 2, 2)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 18px (renders 36px)
      layer.addRow((row) => {
        row.setSize(56, 18).setBackgroundColor(COLORS.header);
        row.addDisplayText('ch-header', (t) =>
          t.setText('CHANNELS')
            .setColor(COLORS.white)
            .setFontSize(16)
            .setFontWeight('bold')
            .setMargin(4, 8, 0, 8)
        );
      });

      // Content row — 82px (renders 164px): wrapping channel list
      layer.addRow((row) => {
        row.setSize(56, 82).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-list', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(16)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 16px (renders 32px): connected count
      layer.addRow((row) => {
        row.setSize(56, 16).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('ch-count', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);

      // Fetch channels on init
      conn.rpc('channels.status', {}).then((r) => {
        renderChannels(dc, r);
      }).catch(() => {
        dc['ch-list']?.set('offline');
      });

      // Re-fetch when connection state changes
      unsub = conn.onChange((c) => {
        if (c.connected) {
          c.rpc('channels.status', {}).then((r) => {
            renderChannels(dc, r);
          }).catch(() => {});
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

function renderChannels(dc, r) {
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
  const ok = lines.filter((l) => l.startsWith('\u25CF')).length;
  dc['ch-list']?.set(lines.join('\n') || 'none');
  dc['ch-count']?.set(`${ok}/${lines.length} connected`);
}

// ---------------------------------------------------------------------------
// Widget 6: Approval (2x1 = 120x240px, usable 112x232, setSize 56x116)
// ---------------------------------------------------------------------------

function registerApproval(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Approval' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer
        .setMargin(2, 2, 2, 2)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Icon row — 40px (renders 80px)
      layer.addRow((row) => {
        row.setSize(56, 40);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
      });

      // Command row — 58px (renders 116px): wrapping command text
      layer.addRow((row) => {
        row.setSize(56, 58).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('all clear')
            .setColor(COLORS.text)
            .setFontSize(16)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      // Controls row — 18px (renders 36px)
      layer.addRow((row) => {
        row.setSize(56, 18).setBackgroundColor(COLORS.black);
        row.addDisplayText('ap-ctrl', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(14)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.pendingApproval) {
          const risk = c.pendingApproval.risk || 'low';
          d['ap-icon']?.set(risk === 'HIGH' ? '\u{1F6A8}' : '\u26A0');
          d['ap-cmd']?.set(`[${risk}] ${c.pendingApproval.command || '?'}`);
          d['ap-ctrl']?.set('\u25C0 YES    NO \u25B6');
        } else {
          d['ap-icon']?.set('\u2713');
          d['ap-cmd']?.set('all clear');
          d['ap-ctrl']?.set('');
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all 6 display widgets on the given configuration.
 *   configuration — Modue plugin configuration object
 *   storage       — plugin storage (for Connection singleton init)
 *   log           — plugin logger
 */
function registerWidgets(configuration, storage, log) {
  registerClawStatus(configuration, storage, log);
  registerClawStream(configuration, storage, log);
  registerClawLive(configuration, storage, log);
  registerClawFull(configuration, storage, log);
  registerChannels(configuration, storage, log);
  registerApproval(configuration, storage, log);
}

module.exports = { registerWidgets };
