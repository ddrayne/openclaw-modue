// Display widgets for the OpenClaw plugin.
// Each widget subscribes to the Connection singleton for state updates.

const { Connection } = require('./connection');
const { COLORS, formatSystemStats, formatLastActivity, formatHealth } = require('./renderer');

// 1x1 transparent PNG — used as the default (invisible) agent image overlay
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAQApDs4AAAAASUVORK5CYII=';

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
 * Render agent-controlled content into a widget's display components.
 */
function renderAgentContent(c, d) {
  const a = c.agentDisplay;
  if (!a) return;

  // Face: show Material Symbol icon, hide emoji
  if (a.face) {
    if (d['face-icon']) d['face-icon'].set(a.face);
    if (d.icon) d.icon.set('');
  }

  // Image: push to overlay
  if (a.image && d['agent-image']) {
    d['agent-image'].set(a.image);
  }

  if (a.title && d.status) d.status.set(a.title);
  if (a.body && d.content) d.content.set(a.body);
  else if (a.body && d['ap-cmd']) d['ap-cmd'].set(a.body);
  if (d.footer) d.footer.set(a.style ? `[${a.style}]` : '');
  if (d.elapsed) d.elapsed.set('');
}

/**
 * Reset face-icon, emoji icon, and agent-image to defaults.
 * Called when leaving agent display mode.
 */
function resetAgentOverlays(d) {
  if (d['face-icon']) d['face-icon'].set('');
  if (d.icon) d.icon.set('\u{1F99E}');
  if (d['agent-image']) d['agent-image'].set(TRANSPARENT_PNG);
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
// Widget 1: Claw Status (1x1 = 120x120px, layer 116x116)
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

      // Icon row — 56px
      layer.addRow((row) => {
        row.setSize(116, 56);
        row.addDisplayText('icon', (t) =>
          t.setText('\u{1F99E}')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(8, 0, 0, 0)
        );
        row.addDisplayText('face-icon', (t) =>
          t.setText('')
            .setFontSize(36)
            .setTextAlign('center')
            .setColor(COLORS.text)
            .setIsIcon(true)
            .setSize(0, 0)
        );
      });

      // Status phrase row — 36px
      layer.addRow((row) => {
        row.setSize(116, 36);
        row.addDisplayText('status', (t) =>
          t.setText('offline')
            .setColor(COLORS.textDim)
            .setFontSize(18)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
            .setTextWrap('ellipsis')
        );
      });

      // Elapsed / detail row — 24px
      layer.addRow((row) => {
        row.setSize(116, 24);
        row.addDisplayText('detail', (t) =>
          t.setText('')
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
        if (c.displayMode === 'agent' && c.agentDisplay) {
          renderAgentContent(c, d);
          d.status?.set(c.agentDisplay.title || c.agentDisplay.body || '');
          d.detail?.set(c.agentDisplay.style || '');
        } else if (c.displayMode === 'ambient') {
          resetAgentOverlays(d);
          d.status?.set(formatSystemStats(c.systemStats, 'compact'));
          d.detail?.set(formatHealth(c.health, c.connected));
        } else {
          resetAgentOverlays(d);
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

      // Header row — 36px: icon (36w) + status (198w) = 234
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
          col.addDisplayText('face-icon', (t) =>
            t.setText('')
              .setFontSize(20)
              .setTextAlign('center')
              .setColor(COLORS.text)
              .setIsIcon(true)
              .setSize(0, 0)
          );
        });
        row.addColumn((col) => {
          col.setSize(198, 36);
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

      // Content row — 168px: wrapping text
      layer.addRow((row) => {
        row.setSize(234, 168).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting...')
            .setColor(COLORS.text)
            .setFontSize(22)
            .setMargin(4, 4, 2, 4)
            .setTextWrap('wrap')
        );
      });

      // Footer row — 30px: channel info
      layer.addRow((row) => {
        row.setSize(234, 30).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setMargin(4, 4, 0, 4)
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
        if (c.displayMode === 'agent' && c.agentDisplay) {
          renderAgentContent(c, d);
        } else if (c.displayMode === 'ambient') {
          resetAgentOverlays(d);
          const activity = formatLastActivity(c.lastActivity);
          const stats = formatSystemStats(c.systemStats, 'compact');
          d.content?.set(`${activity}\n\n${stats}`);
          d.footer?.set(formatHealth(c.health, c.connected));
        } else {
          resetAgentOverlays(d);
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
//   Header: 42  |  Content: 390  |  Footer: 42  = 474
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

      // Header row — 42px: icon (40w) + status (136w) + elapsed (58w) = 234
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
          col.addDisplayText('face-icon', (t) =>
            t.setText('')
              .setFontSize(22)
              .setTextAlign('center')
              .setColor(COLORS.text)
              .setIsIcon(true)
              .setSize(0, 0)
          );
        });
        row.addColumn((col) => {
          col.setSize(136, 42);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(20)
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
              .setFontSize(14)
              .setTextAlign('right')
              .setMargin(12, 3, 0, 0)
          );
        });
      });

      // Content row — 390px: readable text
      layer.addRow((row) => {
        row.setSize(234, 390).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(28)
            .setMargin(6, 5, 4, 5)
            .setTextWrap('wrap')
        );

        // Touch handlers for gesture forwarding
        let touchStart = null;
        row.registerOnTouchStartHandler(() => { touchStart = Date.now(); });
        row.registerOnTouchEndHandler(() => {
          try {
            const conn = Connection.getInstance(storage, log);
            if (touchStart && Date.now() - touchStart < 300) {
              conn.sendTouch('live', 'tap');
            }
          } catch (_) {}
          touchStart = null;
        });
        row.registerOnTouchMoveHandler((value) => {
          try {
            const conn = Connection.getInstance(storage, log);
            if (Math.abs(value.deltaY) > 30) {
              conn.sendTouch('live', value.deltaY < 0 ? 'swipe-up' : 'swipe-down');
            } else if (Math.abs(value.deltaX) > 30) {
              conn.sendTouch('live', value.deltaX > 0 ? 'swipe-right' : 'swipe-left');
            }
          } catch (_) {}
        });
      });

      // Footer row — 42px: channel + controls
      layer.addRow((row) => {
        row.setSize(234, 42).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(14)
            .setMargin(4, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });
    })
    .addLayer((layer) => {
      // Layer 2 — agent image overlay (transparent by default)
      layer.setMargin(3, 3, 3, 3).setBorderRadius(4, 4, 4, 4);
      layer.addRow((row) => {
        row.setSize(234, 474);
        row.addDisplayImage('agent-image', (img) =>
          img
            .setSize(234, 474)
            .setImageBase64Data(TRANSPARENT_PNG)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        if (c.displayMode === 'agent' && c.agentDisplay) {
          renderAgentContent(c, d);
        } else if (c.displayMode === 'ambient') {
          resetAgentOverlays(d);
          const activity = formatLastActivity(c.lastActivity);
          const stats = formatSystemStats(c.systemStats, 'full');
          d.content?.set(`LAST ACTIVITY\n${activity}\n\nSYSTEM\n${stats}`);
          d.elapsed?.set('');
          const labels = [c.keyLabels.left, c.keyLabels.center, c.keyLabels.right].filter(Boolean);
          d.footer?.set(labels.length ? labels.join(' \u2022 ') : formatHealth(c.health, c.connected));
        } else {
          resetAgentOverlays(d);
          d.elapsed?.set(c.statusDetail || '');
          d.content?.set(c.displayText || 'Waiting for activity...');
          const src = formatSource(c);
          const ctrl = formatControls(c);
          const suffix = [src, ctrl].filter(Boolean).join(' \u2022 ');
          d.footer?.set(suffix);
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
//   Header: 48  |  Content: 858  |  Footer: 48  = 954
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

      // Header — 48px: icon (40w) + status (136w) + elapsed (58w) = 234
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
          col.addDisplayText('face-icon', (t) =>
            t.setText('')
              .setFontSize(24)
              .setTextAlign('center')
              .setColor(COLORS.text)
              .setIsIcon(true)
              .setSize(0, 0)
          );
        });
        row.addColumn((col) => {
          col.setSize(136, 48);
          col.addDisplayText('status', (t) =>
            t.setText('offline')
              .setColor(COLORS.text)
              .setFontSize(22)
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

      // Content row — 858px
      layer.addRow((row) => {
        row.setSize(234, 858).setBackgroundColor(COLORS.bg);
        row.addDisplayText('content', (t) =>
          t.setText('Waiting for activity...')
            .setColor(COLORS.text)
            .setFontSize(30)
            .setMargin(6, 5, 4, 5)
            .setTextWrap('wrap')
        );

        // Touch handlers for gesture forwarding
        let touchStart = null;
        row.registerOnTouchStartHandler(() => { touchStart = Date.now(); });
        row.registerOnTouchEndHandler(() => {
          try {
            const conn = Connection.getInstance(storage, log);
            if (touchStart && Date.now() - touchStart < 300) {
              conn.sendTouch('full', 'tap');
            }
          } catch (_) {}
          touchStart = null;
        });
        row.registerOnTouchMoveHandler((value) => {
          try {
            const conn = Connection.getInstance(storage, log);
            if (Math.abs(value.deltaY) > 30) {
              conn.sendTouch('full', value.deltaY < 0 ? 'swipe-up' : 'swipe-down');
            } else if (Math.abs(value.deltaX) > 30) {
              conn.sendTouch('full', value.deltaX > 0 ? 'swipe-right' : 'swipe-left');
            }
          } catch (_) {}
        });
      });

      // Footer row — 48px: channel + controls
      layer.addRow((row) => {
        row.setSize(234, 48).setBackgroundColor(COLORS.bgAlt);
        row.addDisplayText('footer', (t) =>
          t.setText('')
            .setColor(COLORS.textDim)
            .setFontSize(16)
            .setMargin(6, 4, 0, 4)
            .setTextWrap('ellipsis')
        );
      });
    })
    .addLayer((layer) => {
      // Layer 2 — agent image overlay (transparent by default)
      layer.setMargin(3, 3, 3, 3).setBorderRadius(4, 4, 4, 4);
      layer.addRow((row) => {
        row.setSize(234, 954);
        row.addDisplayImage('agent-image', (img) =>
          img
            .setSize(234, 954)
            .setImageBase64Data(TRANSPARENT_PNG)
        );
      });
    })
    .registerOnInitializeHandler((instance) => {
      const dc = instance.components || {};
      const conn = Connection.getInstance(storage, log);
      ensureConnected(conn);
      unsub = bindDisplay(conn, dc, (c, d) => {
        d.status?.set(c.statusPhrase);
        if (c.displayMode === 'agent' && c.agentDisplay) {
          renderAgentContent(c, d);
        } else if (c.displayMode === 'ambient') {
          resetAgentOverlays(d);
          const activity = formatLastActivity(c.lastActivity);
          const stats = formatSystemStats(c.systemStats, 'full');
          d.content?.set(`LAST ACTIVITY\n${activity}\n\nSYSTEM\n${stats}`);
          d.elapsed?.set('');
          const labels = [c.keyLabels.left, c.keyLabels.center, c.keyLabels.right].filter(Boolean);
          d.footer?.set(labels.length ? labels.join(' \u2022 ') : formatHealth(c.health, c.connected));
        } else {
          resetAgentOverlays(d);
          d.elapsed?.set(c.statusDetail || '');
          d.content?.set(c.displayText || 'Waiting for activity...');
          const src = formatSource(c);
          const ctrl = formatControls(c);
          const suffix = [src, ctrl].filter(Boolean).join(' \u2022 ');
          d.footer?.set(suffix);
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

      // Header row — 30px
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

      // Content row — 176px: wrapping channel list
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

      // Footer row — 30px: connected count
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

      // Icon row — 60px
      layer.addRow((row) => {
        row.setSize(116, 60);
        row.addDisplayText('ap-icon', (t) =>
          t.setText('\u2713')
            .setFontSize(36)
            .setTextAlign('center')
            .setMargin(10, 0, 0, 0)
        );
      });

      // Command row — 136px: wrapping command text
      layer.addRow((row) => {
        row.setSize(116, 136).setBackgroundColor(COLORS.bg);
        row.addDisplayText('ap-cmd', (t) =>
          t.setText('all clear')
            .setColor(COLORS.text)
            .setFontSize(14)
            .setMargin(4, 8, 0, 8)
            .setTextWrap('wrap')
        );
      });

      // Controls row — 40px
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
          d['ap-icon']?.set('');
          d['ap-cmd']?.set(c.agentDisplay.body || c.agentDisplay.title || '');
          d['ap-ctrl']?.set('');
        } else {
          const s = c.systemStats;
          d['ap-icon']?.set('');
          d['ap-cmd']?.set(`CPU  ${s.cpu}%\nRAM  ${s.ram}%\nDisk ${s.disk}%\n${s.cpuTemp ? s.cpuTemp + '\u00B0C' : ''}`);
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
