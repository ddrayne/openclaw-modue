// Display widgets for the OpenClaw plugin.
// Each widget subscribes to the Connection singleton for state updates.

const { Connection } = require('./connection');
const { COLORS, formatSystemStats, formatLastActivity, formatHealth } = require('./renderer');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ensureConnected(conn) {
  if (!conn.connected && !conn._client) {
    conn.connect();
  }
}

function formatSource(c) {
  const parts = [];
  if (c.sourceSender) parts.push(c.sourceSender);
  if (c.sourceChannel) {
    parts.push(parts.length ? `via ${c.sourceChannel}` : c.sourceChannel);
  }
  return parts.length ? '\u{1F4AC} ' + parts.join(' ') : '';
}

function formatControls(c) {
  if (!c.pendingApproval) return '';
  const risk = c.pendingApproval.risk === 'HIGH' ? ' \u{1F6A8}' : '';
  return `\u25C0 YES${risk}    NO \u25B6`;
}

function bindDisplay(conn, dc, updateFn) {
  try { updateFn(conn, dc); } catch (_) { /* noop */ }
  return conn.onChange((c) => {
    try { updateFn(c, dc); } catch (_) { /* noop */ }
  });
}

// ---------------------------------------------------------------------------
// Widget 1: Claw Status (1x1 = 120x120px, layer 116x116)
//
//  Ambient:             Streaming:
//  ┌──────────┐         ┌──────────┐
//  │    🦞    │         │    🦞    │
//  │ CPU 34%  │         │ thinking │
//  │  up 2h   │         │   12s    │
//  └──────────┘         └──────────┘
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

      layer.addRow((row) => {
        row.setSize(116, 56);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 36);
        row.addDisplayText('status', (t) =>
          t.setText('offline')
            .setColor(COLORS.textDim)
            .setFontSize(16)
            .setFontWeight('bold')
            .setTextAlign('center')
            .setMargin(2, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 24);
        row.addDisplayText('detail', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(11)
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
        if (c.displayMode === 'agent' && c.agentDisplay) {
          if (c.agentDisplay.face) d.icon?.set(c.agentDisplay.face);
          d.status?.set(c.agentDisplay.title || '');
          d.detail?.set(c.agentDisplay.style || '');
        } else if (c.displayMode === 'ambient') {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.connected ? 'chillin\'' : 'offline');
          d.detail?.set(formatHealth(c.health, c.connected));
        } else {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.statusPhrase);
          d.detail?.set(c.statusDetail || '');
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 2: Claw Stream (2x2 = 240x240px, layer 234x234)
//
//  Ambient:                          Streaming:
//  ┌─ header ──────────────────┐    ┌─ header ──────────────────┐
//  │ 🦞  CPU 34% · RAM 61%    │    │ 🦞  thinking (opus)       │
//  ├───────────────────────────┤    ├───────────────────────────┤
//  │                           │    │                           │
//  │  No recent activity       │    │  Let me check the         │
//  │                           │    │  weather forecast...      │
//  │                           │    │                           │
//  ├─ footer ──────────────────┤    ├─ footer ──────────────────┤
//  │  ● up 2h                  │    │  💬 Dan via Telegram      │
//  └───────────────────────────┘    └───────────────────────────┘
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

      // Header — 36px
      layer.addRow((row) => {
        row.setSize(234, 36).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(36, 36);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(20)
              .setTextAlign('center')
              .setMargin(6, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(198, 36);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(16)
              .setFontWeight('bold')
              .setMargin(8, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });

      // Content — 168px
      layer.addRow((row) => {
        row.setSize(234, 168).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting...')
            .setColor(COLORS.text)
            .setFontSize(20)
            .setMargin(6, 8, 2, 8)
            .setTextWrap('wrap')
        );
      });

      // Footer — 30px
      layer.addRow((row) => {
        row.setSize(234, 30).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(13)
            .setMargin(6, 8, 0, 8)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.displayMode === 'agent' && c.agentDisplay) {
          d.icon?.set(c.agentDisplay.face || '\u{1F99E}');
          d.status?.set(c.agentDisplay.title || '');
          d.content?.set(c.agentDisplay.body || '');
          d.footer?.set(c.agentDisplay.style ? `[${c.agentDisplay.style}]` : '');
        } else if (c.displayMode === 'ambient') {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.connected ? 'chillin\'' : 'offline');
          if (c.displayText) {
            d.content?.set(c.displayText);
          } else {
            d.content?.set(formatLastActivity(c.lastActivity));
          }
          d.footer?.set(formatSource(c));
        } else {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.statusPhrase);
          d.content?.set(c.displayText || 'Waiting...');
          d.footer?.set(formatSource(c));
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 3: Claw Live (4x2 = 240x480px, layer 234x474)
//
//  Ambient:
//  ┌─ header ──────────────────────────┐
//  │ 🦞  CPU 34% · 52°C       up 2h   │
//  ├───────────────────────────────────┤
//  │                                   │
//  │  Dan via Telegram · 4m ago        │
//  │  Replied with the weather         │
//  │  forecast for tomorrow            │
//  │                                   │
//  │  RAM 61%                          │
//  │  Disk 45%                         │
//  │  ↓12 KB/s ↑3 KB/s                │
//  │                                   │
//  ├─ footer ──────────────────────────┤
//  │  ● 3/4 channels                   │
//  └───────────────────────────────────┘
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

      // Header — 42px
      layer.addRow((row) => {
        row.setSize(234, 42).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(40, 42);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(22)
              .setTextAlign('center')
              .setMargin(8, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(136, 42);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(18)
              .setFontWeight('bold')
              .setMargin(10, 2, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(58, 42);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(13)
              .setTextAlign('right')
              .setMargin(12, 3, 0, 0)
          );
        });
      });

      // Content — 390px
      layer.addRow((row) => {
        row.setSize(234, 390).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(22)
            .setLineHeight(30)
            .setMargin(8, 10, 4, 10)
            .setTextWrap('wrap')
        );
      });

      // Footer — 42px
      layer.addRow((row) => {
        row.setSize(234, 42).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setMargin(10, 10, 0, 10)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.displayMode === 'agent' && c.agentDisplay) {
          d.icon?.set(c.agentDisplay.face || '\u{1F99E}');
          d.status?.set(c.agentDisplay.title || '');
          d.elapsed?.set('');
          d.content?.set(c.agentDisplay.body || '');
          d.footer?.set(c.agentDisplay.style ? `[${c.agentDisplay.style}]` : '');
        } else if (c.displayMode === 'ambient') {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.connected ? 'chillin\'' : 'offline');
          d.elapsed?.set(formatHealth(c.health, c.connected));
          // Show last response text or last activity summary — not system stats
          if (c.displayText) {
            d.content?.set(c.displayText);
          } else {
            d.content?.set(formatLastActivity(c.lastActivity));
          }
          d.footer?.set(formatSource(c));
        } else {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.statusPhrase);
          d.elapsed?.set(c.statusDetail || '');
          d.content?.set(c.displayText || 'Waiting for activity...');
          const src = formatSource(c);
          const ctrl = formatControls(c);
          d.footer?.set([src, ctrl].filter(Boolean).join(' \u2022 '));
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 4: Claw Full (8x2 = 240x960px, layer 234x954)
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

      // Header — 48px
      layer.addRow((row) => {
        row.setSize(234, 48).setBackgroundColor(COLORS.header);
        row.addColumn((col) => {
          col.setSize(40, 48);
          col.addDisplayText('icon', (t) =>
            t.setText('\u{1F99E}')
              .setFontSize(24)
              .setTextAlign('center')
              .setMargin(10, 0, 0, 2)
          );
        });
        row.addColumn((col) => {
          col.setSize(136, 48);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(20)
              .setFontWeight('bold')
              .setMargin(12, 2, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(58, 48);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textDim)
              .setFontSize(14)
              .setTextAlign('right')
              .setMargin(14, 3, 0, 0)
          );
        });
      });

      // Content — 858px
      layer.addRow((row) => {
        row.setSize(234, 858).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(26)
            .setLineHeight(34)
            .setMargin(10, 10, 4, 10)
            .setTextWrap('wrap')
        );
      });

      // Footer — 48px
      layer.addRow((row) => {
        row.setSize(234, 48).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(15)
            .setMargin(12, 10, 0, 10)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.displayMode === 'agent' && c.agentDisplay) {
          d.icon?.set(c.agentDisplay.face || '\u{1F99E}');
          d.status?.set(c.agentDisplay.title || '');
          d.elapsed?.set('');
          d.content?.set(c.agentDisplay.body || '');
          d.footer?.set(c.agentDisplay.style ? `[${c.agentDisplay.style}]` : '');
        } else if (c.displayMode === 'ambient') {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.connected ? 'chillin\'' : 'offline');
          d.elapsed?.set(formatHealth(c.health, c.connected));
          if (c.displayText) {
            d.content?.set(c.displayText);
          } else {
            d.content?.set(formatLastActivity(c.lastActivity));
          }
          d.footer?.set(formatSource(c));
        } else {
          d.icon?.set('\u{1F99E}');
          d.status?.set(c.statusPhrase);
          d.elapsed?.set(c.statusDetail || '');
          d.content?.set(c.displayText || 'Waiting for activity...');
          const src = formatSource(c);
          const ctrl = formatControls(c);
          d.footer?.set([src, ctrl].filter(Boolean).join(' \u2022 '));
        }
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 5: Channels (2x1 = 120x240px, layer 116x236)
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

      layer.addRow((row) => {
        row.setSize(116, 30).setBackgroundColor(COLORS.header);
        row.addDisplayText('ch-header', (t) =>
          t.setText('CHANNELS')
            .setColor(COLORS.white)
            .setFontSize(14)
            .setFontWeight('bold')
            .setMargin(6, 8, 0, 8)
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 176).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-list', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 30).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('ch-count', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(12)
            .setTextAlign('center')
            .setMargin(6, 0, 0, 0)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);

      conn.rpc('channels.status', {}).then((r) => {
        renderChannels(dc, r);
      }).catch(() => {
        dc['ch-list']?.set('offline');
      });

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
// Widget 6: Approval (2x1 = 120x240px, layer 116x236)
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

      layer.addRow((row) => {
        row.setSize(116, 60);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setColor(COLORS.green)
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(10, 0, 0, 0)
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 136).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      layer.addRow((row) => {
        row.setSize(116, 40).setBackgroundColor(COLORS.black);
        row.addDisplayText('ap-ctrl', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(14)
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
        if (c.pendingApproval) {
          const risk = c.pendingApproval.risk || 'low';
          d['ap-icon']?.set(risk === 'HIGH' ? '\u{1F6A8}' : '\u26A0');
          d['ap-cmd']?.set(`[${risk}] ${c.pendingApproval.command || '?'}`);
          d['ap-ctrl']?.set('\u25C0 YES    NO \u25B6');
        } else if (c.displayMode === 'agent' && c.agentDisplay) {
          d['ap-icon']?.set(c.agentDisplay.face || '');
          d['ap-cmd']?.set(c.agentDisplay.body || c.agentDisplay.title || '');
          d['ap-ctrl']?.set('');
        } else {
          d['ap-icon']?.set('\u2713');
          d['ap-cmd']?.set(c.connected ? 'all clear' : 'offline');
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

function registerWidgets(configuration, storage, log) {
  registerClawStatus(configuration, storage, log);
  registerClawStream(configuration, storage, log);
  registerClawLive(configuration, storage, log);
  registerClawFull(configuration, storage, log);
  registerChannels(configuration, storage, log);
  registerApproval(configuration, storage, log);
}

module.exports = { registerWidgets };
