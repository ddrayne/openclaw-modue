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
// Widget 1: Claw Status (1x1 = 120x120px, usable 112x112)
// ---------------------------------------------------------------------------

function registerClawStatus(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Status' })
    .setSize(1, 1)
    .addLayer((layer) => {
      layer
        .setMargin(4, 4, 4, 4)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Lobster icon row — 68px
      layer.addRow((row) => {
        row.setSize(112, 68);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(40)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });

      // Status phrase row — 44px
      layer.addRow((row) => {
        row.setSize(112, 44);
        row.addDisplayText('status', (t) =>
          t.setText('zzz')
            .setColor(COLORS.textDim)
            .setFontSize(20)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
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
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 2: Claw Stream (2x2 = 240x240px, usable 228x228)
// ---------------------------------------------------------------------------

function registerClawStream(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Stream' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer
        .setMargin(6, 6, 6, 6)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 52px: emoji (52px) + status (176px)
      layer.addRow((row) => {
        row.setSize(228, 52).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(52, 52);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(28)
              .setTextAlign('center')
              .setMargin(6, 0, 0, 4)
          );
        });
        row.addColumn((col) => {
          col.setSize(176, 52);
          col.addDisplayText('status', (t) =>
            t.setText('zzz')
              .setColor(COLORS.text)
              .setFontSize(22)
              .setFontWeight('bold')
              .setMargin(8, 8, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content row — 140px: wrapping text
      layer.addRow((row) => {
        row.setSize(228, 140).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting...')
            .setColor(COLORS.text)
            .setFontSize(22)
            .setMargin(8, 8, 4, 8)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 36px: channel info
      layer.addRow((row) => {
        row.setSize(228, 36).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(16)
            .setMargin(4, 8, 0, 8)
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
        d.content?.set(c.currentText || 'Waiting...');
        d.channel?.set(c.sourceChannel ? '\u{1F4AC} via ' + c.sourceChannel : '');
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 3: Claw Live (4x2 = 228w x 468h usable, margin 6px)
//   Header: 60  |  Content: 340  |  Channel: 32  |  Controls: 36  = 468
// ---------------------------------------------------------------------------

function registerClawLive(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Live' })
    .setSize(4, 2)
    .addLayer((layer) => {
      layer
        .setMargin(6, 6, 6, 6)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 60px: emoji (60px) + status (168px)
      layer.addRow((row) => {
        row.setSize(228, 60).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(60, 60);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(28)
              .setTextAlign('center')
              .setMargin(8, 0, 0, 4)
          );
        });
        row.addColumn((col) => {
          col.setSize(168, 60);
          col.addDisplayText('status', (t) =>
            t.setText('zzz')
              .setColor(COLORS.text)
              .setFontSize(24)
              .setFontWeight('bold')
              .setMargin(10, 8, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content row — 340px: wrapping text (the hero)
      layer.addRow((row) => {
        row.setSize(228, 340).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(28)
            .setMargin(12, 12, 8, 12)
            .setTextWrap('wrap')
        );
      });

      // Channel row — 32px
      layer.addRow((row) => {
        row.setSize(228, 32).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(18)
            .setMargin(2, 8, 0, 8)
            .setTextWrap('ellipsis')
        );
      });

      // Controls row — 36px (approval buttons, hidden when not needed)
      layer.addRow((row) => {
        row.setSize(228, 36).setBackgroundColor(COLORS.black);
        row.addDisplayText('controls', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(18)
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
        d.status?.set(c.statusPhrase);
        d.content?.set(c.currentText || 'Waiting for activity...');
        d.channel?.set(c.sourceChannel ? '\u{1F4AC} ' + c.sourceChannel : '');
        d.controls?.set(c.pendingApproval ? '\u25C0 yes    no \u25B6' : '');
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 4: Claw Full (8x2 = 228w x 948h usable, margin 6px)
// ---------------------------------------------------------------------------

function registerClawFull(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Full' })
    .setSize(8, 2)
    .addLayer((layer) => {
      layer
        .setMargin(6, 6, 6, 6)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Habitat zone — 180px: big lobster (108px) + status phrase (72px)
      // Icon sub-row
      layer.addRow((row) => {
        row.setSize(228, 108).setBackgroundColor(COLORS.bg);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(48)
            .setTextAlign('center')
            .setMargin(16, 0, 0, 0)
        );
      });

      // Status phrase sub-row
      layer.addRow((row) => {
        row.setSize(228, 72).setBackgroundColor(COLORS.bg);
        row.addDisplayText('status', (t) =>
          t.setText('zzz')
            .setColor(COLORS.text)
            .setFontSize(32)
            .setFontWeight('bold')
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Content row — 668px: massive wrapping text area
      layer.addRow((row) => {
        row.setSize(228, 668).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(30)
            .setMargin(16, 12, 8, 12)
            .setTextWrap('wrap')
        );
      });

      // Footer — channel row (52px)
      layer.addRow((row) => {
        row.setSize(228, 52).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(22)
            .setMargin(8, 8, 0, 8)
            .setTextWrap('ellipsis')
        );
      });

      // Footer — controls row (48px)
      layer.addRow((row) => {
        row.setSize(228, 48).setBackgroundColor(COLORS.black);
        row.addDisplayText('controls', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(22)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        d.content?.set(c.currentText || 'Waiting for activity...');
        d.channel?.set(c.sourceChannel ? '\u{1F4AC} ' + c.sourceChannel : '');
        d.controls?.set(c.pendingApproval ? '\u25C0 yes    no \u25B6' : '');
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 5: Channels (2x1 = 112w x 232h usable, margin 4px)
// ---------------------------------------------------------------------------

function registerChannels(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Channels' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer
        .setMargin(4, 4, 4, 4)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Header row — 36px
      layer.addRow((row) => {
        row.setSize(112, 36).setBackgroundColor(COLORS.header);
        row.addDisplayText('ch-header', (t) =>
          t.setText('CHANNELS')
            .setColor(COLORS.white)
            .setFontSize(16)
            .setFontWeight('bold')
            .setMargin(4, 8, 0, 8)
        );
      });

      // Content row — 164px: wrapping channel list
      layer.addRow((row) => {
        row.setSize(112, 164).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-list', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(16)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 32px: connected count
      layer.addRow((row) => {
        row.setSize(112, 32).setBackgroundColor(COLORS.bgAlt);
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
      const shortName = (labels[ch] || ch).slice(0, 2).toUpperCase();
      lines.push(`${a.connected ? '\u25CF' : '\u25CB'} ${shortName}`);
    }
  }
  const ok = lines.filter((l) => l.startsWith('\u25CF')).length;
  dc['ch-list']?.set(lines.join('\n') || 'none');
  dc['ch-count']?.set(`${ok}/${lines.length}`);
}

// ---------------------------------------------------------------------------
// Widget 6: Approval (2x1 = 112w x 232h usable, margin 4px)
// ---------------------------------------------------------------------------

function registerApproval(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Approval' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer
        .setMargin(4, 4, 4, 4)
        .setBorderRadius(4, 4, 4, 4)
        .setBackgroundColor(COLORS.bg);

      // Icon row — 80px
      layer.addRow((row) => {
        row.setSize(112, 80);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
      });

      // Command row — 116px: wrapping command text
      layer.addRow((row) => {
        row.setSize(112, 116).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('all clear')
            .setColor(COLORS.text)
            .setFontSize(16)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      // Controls row — 36px
      layer.addRow((row) => {
        row.setSize(112, 36).setBackgroundColor(COLORS.black);
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
          d['ap-icon']?.set('\u26A0');
          d['ap-cmd']?.set(c.pendingApproval.command || '?');
          d['ap-ctrl']?.set('\u25C0 Y  N \u25B6');
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
