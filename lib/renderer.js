// Shared display rendering utilities for the Modue display

// Apple Watch-inspired palette — true black, minimal, premium
const COLORS = {
  bg: '#000000',          // true black — OLED perfection
  bgAlt: '#0a0a0a',       // barely-there dark for subtle separation
  header: '#0a0a0a',      // near-black header, not a colored bar
  text: '#f5f5f7',        // Apple's off-white
  textDim: '#86868b',     // Apple's secondary gray
  textMuted: '#48484a',   // very subtle tertiary
  accent: '#0a84ff',      // iOS blue
  green: '#30d158',       // iOS green
  greenDim: '#1a7a00',
  red: '#ff453a',         // iOS red
  yellow: '#ffd60a',      // iOS yellow
  amber: '#ff9f0a',       // iOS orange
  blue: '#0a84ff',        // iOS blue
  blueDim: '#0040dd',
  purple: '#bf5af2',      // iOS purple — for thinking
  white: '#ffffff',
  black: '#000000',
};

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function timeAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function statusDot(connected, enabled, healthState, reconnectAttempts) {
  if (!enabled) return { char: '\u25cb', color: COLORS.textDim };     // hollow circle
  if (healthState === 'error') return { char: '\u25cf', color: COLORS.red };
  if (reconnectAttempts > 0) return { char: '\u25cf', color: COLORS.yellow };
  if (connected) return { char: '\u25cf', color: COLORS.green };
  return { char: '\u25cf', color: COLORS.textDim };
}

function statusColor(status) {
  if (status === 'running') return COLORS.blue;
  if (status === 'error') return COLORS.red;
  if (status === 'idle') return COLORS.green;
  return COLORS.textDim;
}

function agentLineColor(type) {
  if (type === 'thinking') return COLORS.textDim;
  if (type === 'assistant') return COLORS.text;
  if (type === 'tool') return COLORS.amber;
  if (type === 'tool-end') return COLORS.greenDim;
  if (type === 'lifecycle') return COLORS.blueDim;
  if (type === 'error') return COLORS.red;
  if (type === 'approval') return COLORS.amber;
  return COLORS.text;
}

// Build a standard header row for a display layer
function addHeaderRow(layer, title, rightText, displayW) {
  layer.addRow((row) => {
    row.setSize(displayW, 16)
      .setBackgroundColor(COLORS.header);
    row.addDisplayText('header-title', (t) =>
      t.setText(title)
        .setColor(COLORS.white)
        .setFontSize(11)
        .setFontWeight('bold')
        .setMargin(2, 4, 0, 4)
    );
    if (rightText) {
      row.addDisplayText('header-right', (t) =>
        t.setText(rightText)
          .setColor(COLORS.textDim)
          .setFontSize(10)
          .setMargin(3, 4, 0, 0)
          .setTextAlign('right')
      );
    }
  });
}

// Build a text line row (for scrolling text buffers)
function addTextRow(layer, id, text, color, displayW, fontSize) {
  layer.addRow((row) => {
    row.setSize(displayW, 14);
    row.addDisplayText(id, (t) =>
      t.setText(text || '')
        .setColor(color || COLORS.text)
        .setFontSize(fontSize || 10)
        .setMargin(1, 4, 0, 4)
        .setTextWrap('ellipsis')
    );
  });
}

// Build a footer row with key labels
function addFooterRow(layer, labels, displayW) {
  layer.addRow((row) => {
    row.setSize(displayW, 16)
      .setBackgroundColor(COLORS.bgAlt);
    const colW = Math.floor(displayW / labels.length);
    for (let i = 0; i < labels.length; i++) {
      row.addColumn((col) => {
        col.setSize(colW, 16);
        col.addDisplayText(`footer-${i}`, (t) =>
          t.setText(labels[i])
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
    }
  });
}

/**
 * Format system stats for display.
 * 'compact' = single line: "CPU 34% · RAM 61%"
 * 'full' = multi-line, clean readable text (no monospace tricks)
 */
function formatSystemStats(stats, mode) {
  if (!stats) return '';
  if (mode === 'compact') {
    return `CPU ${stats.cpu}% \u00B7 RAM ${stats.ram}%`;
  }
  const lines = [];
  lines.push(`CPU ${stats.cpu}%${stats.cpuTemp ? '  ' + stats.cpuTemp + '\u00B0C' : ''}`);
  lines.push(`RAM ${stats.ram}%`);
  lines.push(`Disk ${stats.disk}%`);
  const down = stats.netDown >= 1000 ? `${(stats.netDown / 1000).toFixed(1)} MB/s` : `${Math.round(stats.netDown)} KB/s`;
  const up = stats.netUp >= 1000 ? `${(stats.netUp / 1000).toFixed(1)} MB/s` : `${Math.round(stats.netUp)} KB/s`;
  lines.push(`\u2193${down} \u2191${up}`);
  return lines.join('\n');
}

/**
 * Format last activity for display.
 */
function formatLastActivity(lastActivity) {
  if (!lastActivity) return 'No recent activity';
  const ago = timeAgo(lastActivity.endedAt);
  const who = [lastActivity.sender, lastActivity.channel].filter(Boolean).join(' via ');
  const prefix = who ? `${who} \u00B7 ${ago} ago` : `${ago} ago`;
  return `${prefix}\n${lastActivity.summary}`;
}

/**
 * Format connection health.
 */
function formatHealth(health, connected) {
  if (!connected) return '\u25CF offline';
  const uptime = health.connectedSince ? timeAgo(health.connectedSince) : '?';
  const reconn = health.reconnects > 0 ? ` \u00B7 ${health.reconnects} reconn` : '';
  return `\u25CF up ${uptime}${reconn}`;
}

module.exports = {
  COLORS,
  truncate,
  timeAgo,
  statusDot,
  statusColor,
  agentLineColor,
  addHeaderRow,
  addTextRow,
  addFooterRow,
  formatSystemStats,
  formatLastActivity,
  formatHealth,
};
