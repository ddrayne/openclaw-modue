// Display widgets for the OpenClaw plugin.
// Apple Watch-inspired design: true black, minimal chrome, elegant type.

const { Connection } = require('./connection');
const { COLORS, formatLastActivity, formatHealth } = require('./renderer');

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
  return parts.join(' ') || '';
}

function formatControls(c) {
  if (!c.pendingApproval) return '';
  const risk = c.pendingApproval.risk === 'HIGH' ? ' \u{1F6A8}' : '';
  return `\u25C0 YES${risk}    NO \u25B6`;
}

function bindDisplay(conn, dc, updateFn) {
  try { updateFn(conn, dc); } catch (_) {}
  return conn.onChange((c) => {
    try { updateFn(c, dc); } catch (_) {}
  });
}

// ---------------------------------------------------------------------------
// Widget 1: Claw Status (1x1 = 120x120px)
// Complication style — centered icon, status word, subtle detail
// ---------------------------------------------------------------------------

function registerClawStatus(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Status' })
    .setSize(1, 1)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Top breathing room
      layer.addRow((row) => {
        row.setSize(120, 18).setBackgroundColor(COLORS.bg);
        row.addDisplayText('_sp', (t) => t.setText(''));
      });

      // Icon — octopus
      layer.addRow((row) => {
        row.setSize(120, 44);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F419}')
            .setFontSize(32)
            .setTextAlign('center')
        );
      });

      // Status word
      layer.addRow((row) => {
        row.setSize(120, 32);
        row.addDisplayText('status', (t) =>
          t.setText('offline')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setTextAlign('center')
            .setMargin(6, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Timer / detail
      layer.addRow((row) => {
        row.setSize(120, 26);
        row.addDisplayText('detail', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
            .setTextAlign('center')
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        // Change icon color based on status
        const statusColors = {
          thinking: COLORS.purple,
          talking: COLORS.blue,
          working: COLORS.amber,
          error: COLORS.red,
          idle: COLORS.green,
          offline: COLORS.textMuted,
        };
        const iconColor = statusColors[c.agentStatus] || COLORS.textDim;
        // Note: setText + setColor would need to be done at layer init time
        // For now, we just update the icon emoji
        d.icon?.set('\u{1F419}');
        if (c.agentStatus === 'idle' || c.agentStatus === 'offline') {
          d.status?.set(c.connected ? 'ready' : 'offline');
          d.detail?.set('');
        } else {
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
// Widget 2: Claw Stream (2x2 = 240x240px)
// Compact card — thin status line at top, content fills the rest
// ---------------------------------------------------------------------------

function registerClawStream(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Stream' })
    .setSize(2, 2)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Status line — 28px, just text, no background bar
      layer.addRow((row) => {
        row.setSize(240, 28).setBackgroundColor(COLORS.bg);
        row.addColumn((col) => {
          col.setSize(180, 28);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.textDim)
              .setFontSize(13)
              .setMargin(8, 12, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(60, 28);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textMuted)
              .setFontSize(11)
              .setTextAlign('right')
              .setMargin(9, 0, 0, 10)
          );
        });
      });

      // Thin accent line — 1px
      layer.addRow((row) => {
        row.setSize(240, 1).setBackgroundColor(COLORS.textMuted);
        row.addDisplayText('_line', (t) => t.setText(''));
      });

      // Content — 211px
      layer.addRow((row) => {
        row.setSize(240, 211).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(18)
            .setMargin(8, 12, 4, 12)
            .setTextWrap('wrap')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.agentStatus === 'idle' || c.agentStatus === 'offline') {
          d.status?.set(c.connected ? 'ready' : 'offline');
          d.elapsed?.set('');
        } else {
          d.status?.set(c.statusPhrase);
          d.elapsed?.set(c.statusDetail || '');
        }
        d.content?.set(c.displayText || formatLastActivity(c.lastActivity));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 3: Claw Live (4x2 = 240x480px)
// Main display — clean status line, generous content, subtle source
// ---------------------------------------------------------------------------

function registerClawLive(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Live' })
    .setSize(4, 2)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Status line — 32px
      layer.addRow((row) => {
        row.setSize(240, 32).setBackgroundColor(COLORS.bg);
        row.addColumn((col) => {
          col.setSize(180, 32);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.textDim)
              .setFontSize(14)
              .setMargin(10, 14, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(60, 32);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textMuted)
              .setFontSize(12)
              .setTextAlign('right')
              .setMargin(11, 0, 0, 12)
          );
        });
      });

      // Accent line — 1px
      layer.addRow((row) => {
        row.setSize(240, 1).setBackgroundColor(COLORS.textMuted);
        row.addDisplayText('_line', (t) => t.setText(''));
      });

      // Content — 417px
      layer.addRow((row) => {
        row.setSize(240, 417).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(20)
            .setLineHeight(28)
            .setMargin(10, 14, 4, 14)
            .setTextWrap('wrap')
        );
      });

      // Source — 30px, bottom aligned
      layer.addRow((row) => {
        row.setSize(240, 30).setBackgroundColor(COLORS.bg);
        row.addDisplayText('source', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
            .setMargin(6, 14, 0, 14)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.agentStatus === 'idle' || c.agentStatus === 'offline') {
          d.status?.set(c.connected ? 'ready' : 'offline');
          d.elapsed?.set('');
        } else {
          d.status?.set(c.statusPhrase);
          d.elapsed?.set(c.statusDetail || '');
        }
        d.content?.set(c.displayText || formatLastActivity(c.lastActivity));
        d.source?.set(formatSource(c));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 4: Claw Full (8x2 = 240x960px)
// The big one — immersive reading experience
// ---------------------------------------------------------------------------

function registerClawFull(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Claw Full' })
    .setSize(8, 2)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Status line — 36px
      layer.addRow((row) => {
        row.setSize(240, 36).setBackgroundColor(COLORS.bg);
        row.addColumn((col) => {
          col.setSize(180, 36);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.textDim)
              .setFontSize(15)
              .setMargin(12, 16, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
        row.addColumn((col) => {
          col.setSize(60, 36);
          col.addDisplayText('elapsed', (t) =>
            t.setText('')
              .setColor(COLORS.textMuted)
              .setFontSize(13)
              .setTextAlign('right')
              .setMargin(13, 0, 0, 14)
          );
        });
      });

      // Accent line — 1px
      layer.addRow((row) => {
        row.setSize(240, 1).setBackgroundColor(COLORS.textMuted);
        row.addDisplayText('_line', (t) => t.setText(''));
      });

      // Content — 889px — the main event
      layer.addRow((row) => {
        row.setSize(240, 889).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(24)
            .setLineHeight(32)
            .setMargin(12, 16, 4, 16)
            .setTextWrap('wrap')
        );
      });

      // Source — 34px
      layer.addRow((row) => {
        row.setSize(240, 34).setBackgroundColor(COLORS.bg);
        row.addDisplayText('source', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(12)
            .setMargin(8, 16, 0, 16)
            .setTextWrap('ellipsis')
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        if (c.agentStatus === 'idle' || c.agentStatus === 'offline') {
          d.status?.set(c.connected ? 'ready' : 'offline');
          d.elapsed?.set('');
        } else {
          d.status?.set(c.statusPhrase);
          d.elapsed?.set(c.statusDetail || '');
        }
        d.content?.set(c.displayText || formatLastActivity(c.lastActivity));
        const src = formatSource(c);
        const ctrl = formatControls(c);
        d.source?.set([src, ctrl].filter(Boolean).join('  \u2022  '));
      });
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) { unsub(); unsub = null; }
    });
}

// ---------------------------------------------------------------------------
// Widget 5: Channels (2x1 = 120x240px)
// Vertical list — minimal header, dot indicators
// ---------------------------------------------------------------------------

function registerChannels(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Channels' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Header label — 28px
      layer.addRow((row) => {
        row.setSize(120, 28).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-header', (t) =>
          t.setText('channels')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
            .setMargin(10, 10, 0, 10)
        );
      });

      // Line
      layer.addRow((row) => {
        row.setSize(120, 1).setBackgroundColor(COLORS.textMuted);
        row.addDisplayText('_line', (t) => t.setText(''));
      });

      // Channel list — 181px
      layer.addRow((row) => {
        row.setSize(120, 181).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-list', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(13)
            .setMargin(6, 10, 0, 10)
            .setTextWrap('wrap')
        );
      });

      // Count — 30px
      layer.addRow((row) => {
        row.setSize(120, 30).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ch-count', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
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
  dc['ch-count']?.set(`${ok}/${lines.length}`);
}

// ---------------------------------------------------------------------------
// Widget 6: Approval (2x1 = 120x240px)
// Clean vertical card — icon, command, action hint
// ---------------------------------------------------------------------------

function registerApproval(configuration, storage, log) {
  let unsub = null;

  configuration
    .registerDisplay({ name: 'Approval' })
    .setSize(2, 1)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Icon area — 56px
      layer.addRow((row) => {
        row.setSize(120, 56);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setColor(COLORS.green)
            .setFontSize(32)
            .setTextAlign('center')
            .setMargin(12, 0, 0, 0)
        );
      });

      // Command text — 144px
      layer.addRow((row) => {
        row.setSize(120, 144).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(13)
            .setMargin(4, 10, 0, 10)
            .setTextWrap('wrap')
        );
      });

      // Action hint — 40px
      layer.addRow((row) => {
        row.setSize(120, 40).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-ctrl', (t) =>
          t.setText('')
            .setColor(COLORS.amber)
            .setFontSize(13)
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
          d['ap-icon']?.set(risk === 'HIGH' ? '\u26A0' : '\u2022');
          d['ap-cmd']?.set(c.pendingApproval.command || '?');
          d['ap-ctrl']?.set('\u25C0 yes    no \u25B6');
        } else {
          d['ap-icon']?.set('\u2713');
          d['ap-cmd']?.set(c.connected ? 'all clear' : '');
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
// Widget 7: Claw Info (1x1 = 120x120px)
// Context-aware info display — sits next to slider
// Shows: scroll position / model / cost / approval alert
// ---------------------------------------------------------------------------

function registerClawInfo(configuration, storage, log) {
  let unsub = null;
  let costCache = { text: '', fetchedAt: 0 };

  configuration
    .registerDisplay({ name: 'Claw Info' })
    .setSize(1, 1)
    .addLayer((layer) => {
      layer.setMargin(0, 0, 0, 0).setBackgroundColor(COLORS.bg);

      // Top line — context label
      layer.addRow((row) => {
        row.setSize(120, 30).setBackgroundColor(COLORS.bg);
        row.addDisplayText('info-label', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
            .setTextAlign('center')
            .setMargin(12, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Main value — big centered text
      layer.addRow((row) => {
        row.setSize(120, 50);
        row.addDisplayText('info-value', (t) =>
          t.setText('')
            .setColor(COLORS.text)
            .setFontSize(24)
            .setTextAlign('center')
            .setMargin(6, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });

      // Bottom detail
      layer.addRow((row) => {
        row.setSize(120, 40).setBackgroundColor(COLORS.bg);
        row.addDisplayText('info-detail', (t) =>
          t.setText('')
            .setColor(COLORS.textMuted)
            .setFontSize(11)
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

      // Fetch cost periodically
      const fetchCost = () => {
        conn.rpc('usage.cost', {}).then((r) => {
          const cost = r?.totalCost;
          if (cost != null) {
            costCache = { text: `\u00A3${cost.toFixed(2)}`, fetchedAt: Date.now() };
          }
        }).catch(() => {});
      };
      fetchCost();
      const costInterval = setInterval(fetchCost, 30000); // refresh every 30s

      unsub = bindDisplay(conn, dc, (c, d) => {
        // Priority 1: Approval pending
        if (c.pendingApproval) {
          d['info-label']?.set('approval');
          d['info-value']?.set('\u26A0 EXEC');
          d['info-detail']?.set(c.pendingApproval.risk === 'HIGH' ? 'HIGH RISK' : 'review');
          return;
        }

        // Priority 2: Scrolling
        if (c.scrollMode) {
          const pct = Math.round(c.scrollOffset * 100);
          d['info-label']?.set('scroll');
          d['info-value']?.set(`\u25B2 ${pct}%`);
          d['info-detail']?.set('\u25BC live');
          return;
        }

        // Priority 3: Active (thinking/talking/working)
        if (c.agentStatus === 'thinking' || c.agentStatus === 'talking' || c.agentStatus === 'working') {
          const model = c.currentModel;
          const short = model
            ? model.replace(/^.*\//, '').replace(/claude-/i, '').replace(/gpt-/i, 'gpt').slice(0, 12)
            : '';
          d['info-label']?.set(c.agentStatus);
          d['info-value']?.set(short || c.agentStatus);
          d['info-detail']?.set(c.statusDetail || '');
          return;
        }

        // Priority 4: Idle — show cost
        d['info-label']?.set('today');
        d['info-value']?.set(costCache.text || '\u2014');
        d['info-detail']?.set(c.connected ? 'ready' : 'offline');
      });

      // Store interval for cleanup
      unsub._costInterval = costInterval;
    })
    .registerOnConfigurationChangeHandler(() => {})
    .registerOnDeactivateHandler(() => {
      if (unsub) {
        if (unsub._costInterval) clearInterval(unsub._costInterval);
        unsub();
        unsub = null;
      }
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
  registerClawInfo(configuration, storage, log);
}

module.exports = { registerWidgets };
