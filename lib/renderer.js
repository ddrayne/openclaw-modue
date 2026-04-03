// Shared display rendering utilities for the Modue display

const COLORS = {
  bg: '#1a1a2e',
  bgAlt: '#16213e',
  header: '#0f3460',
  text: '#e8e8e8',
  textDim: '#7a7a8a',
  accent: '#e94560',
  green: '#31e000',
  greenDim: '#1a7a00',
  red: '#ff3333',
  yellow: '#e0d100',
  amber: '#ff9900',
  blue: '#4488ff',
  blueDim: '#2244aa',
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
};
