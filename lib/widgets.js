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
// Widget 1: Claw Status (1x1 = 60x60px)
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

      // Lobster icon row — 34px
      layer.addRow((row) => {
        row.setSize(56, 34);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(28)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
        );
      });

      // Status phrase row — 22px
      layer.addRow((row) => {
        row.setSize(56, 22);
        row.addDisplayText('status', (t) =>
          t.setText('zzz')
            .setColor(COLORS.textDim)
            .setFontSize(12)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
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
// Widget 2: Claw Stream (2x2 = 120x120px)
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

      // Header row — 26px: emoji (26px) + status (88px)
      layer.addRow((row) => {
        row.setSize(114, 26).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(26, 26);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(16)
              .setTextAlign('center')
              .setMargin(3, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(88, 26);
          col.addDisplayText('status', (t) =>
            t.setText('zzz')
              .setColor(COLORS.text)
              .setFontSize(16)
              .setFontWeight('bold')
              .setMargin(4, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content row — 68px: wrapping text
      layer.addRow((row) => {
        row.setSize(114, 68).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting...')
            .setColor(COLORS.text)
            .setFontSize(16)
            .setMargin(4, 4, 2, 4)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 18px: channel info
      layer.addRow((row) => {
        row.setSize(114, 18).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(11)
            .setMargin(2, 4, 0, 4)
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
// Widget 3: Claw Live (4x2 = 240x120px)
//   Usable area: 114w x 234h (3px margin each side)
//   Header: 30  |  Content: 170  |  Channel: 16  |  Controls: 18  = 234
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

      // Header row — 30px: emoji (30px) + status (84px)
      layer.addRow((row) => {
        row.setSize(114, 30).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(30, 30);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(18)
              .setTextAlign('center')
              .setMargin(4, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(84, 30);
          col.addDisplayText('status', (t) =>
            t.setText('zzz')
              .setColor(COLORS.text)
              .setFontSize(18)
              .setFontWeight('bold')
              .setMargin(5, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content row — 170px: wrapping text (the hero)
      layer.addRow((row) => {
        row.setSize(114, 170).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(20)
            .setMargin(6, 6, 4, 6)
            .setTextWrap('wrap')
        );
      });

      // Channel row — 16px
      layer.addRow((row) => {
        row.setSize(114, 16).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setMargin(1, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Controls row — 18px (approval buttons, hidden when not needed)
      layer.addRow((row) => {
        row.setSize(114, 18).setBackgroundColor(COLORS.black);
        row.addDisplayText('controls', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(12)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
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
// Widget 4: Claw Full (8x2 = 480x120px)
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

      // Habitat zone — 90px: big lobster (54px) + status phrase (36px)
      // Icon sub-row
      layer.addRow((row) => {
        row.setSize(114, 54).setBackgroundColor(COLORS.bg);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
      });

      // Status phrase sub-row
      layer.addRow((row) => {
        row.setSize(114, 36).setBackgroundColor(COLORS.bg);
        row.addDisplayText('status', (t) =>
          t.setText('zzz')
            .setColor(COLORS.text)
            .setFontSize(24)
            .setFontWeight('bold')
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Content row — 330px: massive wrapping text area
      layer.addRow((row) => {
        row.setSize(114, 330).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(22)
            .setMargin(8, 6, 4, 6)
            .setTextWrap('wrap')
        );
      });

      // Footer — channel row (26px)
      layer.addRow((row) => {
        row.setSize(114, 26).setBackgroundColor(COLORS.black);
        row.addDisplayText('channel', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(16)
            .setMargin(4, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Footer — controls row (24px)
      layer.addRow((row) => {
        row.setSize(114, 24).setBackgroundColor(COLORS.black);
        row.addDisplayText('controls', (t) =>
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
// Widget 5: Channels (2x1 = 120×60px)
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

      // Header row — 18px
      layer.addRow((row) => {
        row.setSize(56, 18).setBackgroundColor(COLORS.header);
        row.addDisplayText('ch-header', (t) =>
          t.setText('CHANNELS')
            .setColor(COLORS.white)
            .setFontSize(11)
            .setFontWeight('bold')
            .setMargin(2, 4, 0, 4)
        );
      });

      // Content row — 80px: wrapping channel list
      layer.addRow((row) => {
        row.setSize(56, 80).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-list', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(11)
            .setMargin(2, 4, 0, 4)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 16px: connected count
      layer.addRow((row) => {
        row.setSize(56, 16).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('ch-count', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(10)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
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
// Widget 6: Approval (2x1 = 120×60px)
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

      // Icon row — 40px
      layer.addRow((row) => {
        row.setSize(56, 40);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setFontSize(28)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });

      // Command row — 56px: wrapping command text
      layer.addRow((row) => {
        row.setSize(56, 56).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('all clear')
            .setColor(COLORS.text)
            .setFontSize(11)
            .setMargin(2, 4, 0, 4)
            .setTextWrap('wrap')
        );
      });

      // Controls row — 18px
      layer.addRow((row) => {
        row.setSize(56, 18).setBackgroundColor(COLORS.black);
        row.addDisplayText('ap-ctrl', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(10)
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
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
