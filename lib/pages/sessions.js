const { COLORS, truncate, timeAgo } = require('../renderer');

const VISIBLE_ROWS = 6;

class SessionsPage {
  constructor(state, client, log) {
    this.state = state;
    this.client = client;
    this.log = log;
    this._unsubscribers = [];
  }

  activate() {
    this._fetchSessions();
    this._unsubscribers.push(
      this.client.on('sessions.changed', () => this._fetchSessions())
    );
  }

  deactivate() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  async _fetchSessions() {
    try {
      const result = await this.client.rpc('sessions.list', { limit: 30 });
      const sessions = (result.sessions || result || []).map((s) => ({
        sessionKey: s.sessionKey || s.key,
        sessionId: s.sessionId,
        label: s.label || s.displayName || s.sessionKey || s.key || 'unnamed',
        status: s.status || 'idle',
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        model: s.model || '',
        inputTokens: s.inputTokens || 0,
        outputTokens: s.outputTokens || 0,
        estimatedCostUsd: s.estimatedCostUsd || 0,
        lastChannel: s.lastChannel || '',
        lastTo: s.lastTo || '',
      }));
      this.state.updateSessions({ list: sessions });
    } catch (err) {
      this.log.error(`Failed to fetch sessions: ${err.message}`);
    }
  }

  // --- Controls ---

  onScroll(value) {
    const maxIdx = Math.max(0, this.state.sessions.list.length - 1);
    const idx = Math.round((value / 100) * maxIdx);
    this.state.updateSessions({ selectedIndex: idx });
    // Adjust scroll offset to keep selected item visible
    const offset = Math.max(0, Math.min(idx - 2, this.state.sessions.list.length - VISIBLE_ROWS));
    this.state.updateSessions({ scrollOffset: Math.max(0, offset) });
  }

  onSelect() {
    const { sessions } = this.state;
    const selected = sessions.list[sessions.selectedIndex];
    if (!selected) return;

    if (!sessions.detailView) {
      // Show detail view
      this.state.updateSessions({ detailView: true });
    }
  }

  onWatch() {
    const { sessions } = this.state;
    const selected = sessions.list[sessions.selectedIndex];
    if (!selected) return;

    // Subscribe to this session and switch to Agent Live
    this.state.updateAgent({
      sessionKey: selected.sessionKey,
      sessionLabel: selected.label,
    });
    this.state.updateSessions({ detailView: false });

    // Subscribe to session messages
    this.client.rpc('sessions.messages.subscribe', {
      sessionKey: selected.sessionKey,
    }).catch((err) => {
      this.log.error(`Failed to subscribe to session: ${err.message}`);
    });

    // Switch to agent page
    this.state.update({ currentPage: 'agent' });
  }

  onBack() {
    this.state.updateSessions({ detailView: false });
  }

  // --- Rendering ---

  render(layer, displayW, displayH) {
    const { sessions } = this.state;

    if (sessions.detailView) {
      this._renderDetail(layer, displayW);
      return;
    }

    this._renderList(layer, displayW);
  }

  _renderList(layer, displayW) {
    const { sessions } = this.state;
    const list = sessions.list;

    // Header
    layer.addRow((row) => {
      row.setSize(displayW, 18).setBackgroundColor(COLORS.header);
      row.addDisplayText('h-title', (t) =>
        t.setText('SESSIONS')
          .setColor(COLORS.white)
          .setFontSize(11)
          .setFontWeight('bold')
          .setMargin(3, 6, 0, 6)
      );
      row.addDisplayText('h-count', (t) =>
        t.setText(`${list.length}`)
          .setColor(COLORS.textDim)
          .setFontSize(10)
          .setTextAlign('right')
          .setMargin(4, 6, 0, 0)
      );
    });

    // Session rows
    const visible = list.slice(sessions.scrollOffset, sessions.scrollOffset + VISIBLE_ROWS);
    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const sess = visible[i];
      const actualIdx = sessions.scrollOffset + i;
      const isSelected = actualIdx === sessions.selectedIndex;

      layer.addRow((row) => {
        row.setSize(displayW, 14).setBackgroundColor(isSelected ? COLORS.blueDim : (i % 2 === 0 ? COLORS.bg : COLORS.bgAlt));
        if (sess) {
          const arrow = isSelected ? '\u25b8 ' : '  ';
          const statusIndicator = sess.status === 'running' ? ' \u25cf' : '';
          const ago = timeAgo(sess.endedAt || sess.startedAt);

          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.65), 14);
            col.addDisplayText(`name-${i}`, (t) =>
              t.setText(`${arrow}${truncate(sess.label, 20)}`)
                .setColor(isSelected ? COLORS.white : COLORS.text)
                .setFontSize(10)
                .setMargin(1, 4, 0, 4)
                .setTextWrap('ellipsis')
            );
          });
          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.2), 14);
            col.addDisplayText(`status-${i}`, (t) =>
              t.setText(`${sess.status}${statusIndicator}`)
                .setColor(sess.status === 'running' ? COLORS.blue : COLORS.textDim)
                .setFontSize(9)
                .setMargin(2, 0, 0, 0)
            );
          });
          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.15), 14);
            col.addDisplayText(`ago-${i}`, (t) =>
              t.setText(ago)
                .setColor(COLORS.textDim)
                .setFontSize(9)
                .setTextAlign('right')
                .setMargin(2, 4, 0, 0)
            );
          });
        } else {
          row.addDisplayText(`empty-${i}`, (t) =>
            t.setText('').setColor(COLORS.textDim).setFontSize(10)
          );
        }
      });
    }

    // Footer
    layer.addRow((row) => {
      row.setSize(displayW, 16).setBackgroundColor(COLORS.black);
      const labels = ['\u25c0 CH', '\u25b2\u25bc SCROLL', 'SELECT', 'PG \u25b6'];
      const colW = Math.floor(displayW / labels.length);
      for (let i = 0; i < labels.length; i++) {
        row.addColumn((col) => {
          col.setSize(colW, 16);
          col.addDisplayText(`f-${i}`, (t) =>
            t.setText(labels[i])
              .setColor(COLORS.textDim)
              .setFontSize(8)
              .setTextAlign('center')
              .setMargin(4, 0, 0, 0)
          );
        });
      }
    });
  }

  _renderDetail(layer, displayW) {
    const { sessions } = this.state;
    const sess = sessions.list[sessions.selectedIndex];
    if (!sess) return;

    // Title
    layer.addRow((row) => {
      row.setSize(displayW, 18).setBackgroundColor(COLORS.header);
      row.addDisplayText('d-title', (t) =>
        t.setText(truncate(sess.label, 30))
          .setColor(COLORS.white)
          .setFontSize(11)
          .setFontWeight('bold')
          .setMargin(3, 6, 0, 6)
      );
    });

    // Detail rows
    const details = [
      ['Model', truncate(sess.model || 'default', 25)],
      ['Tokens', `${formatTokens(sess.inputTokens)} in / ${formatTokens(sess.outputTokens)} out`],
      ['Cost', sess.estimatedCostUsd ? `$${sess.estimatedCostUsd.toFixed(2)}` : '--'],
      ['Started', sess.startedAt ? timeAgo(sess.startedAt) + ' ago' : '--'],
      ['Channel', truncate(`${sess.lastChannel || '--'} \u2192 ${sess.lastTo || '--'}`, 25)],
      ['Status', sess.status],
    ];

    for (let i = 0; i < details.length; i++) {
      layer.addRow((row) => {
        row.setSize(displayW, 13).setBackgroundColor(i % 2 === 0 ? COLORS.bg : COLORS.bgAlt);
        row.addColumn((col) => {
          col.setSize(Math.floor(displayW * 0.3), 13);
          col.addDisplayText(`dk-${i}`, (t) =>
            t.setText(details[i][0])
              .setColor(COLORS.textDim)
              .setFontSize(9)
              .setMargin(2, 6, 0, 6)
          );
        });
        row.addColumn((col) => {
          col.setSize(Math.floor(displayW * 0.7), 13);
          col.addDisplayText(`dv-${i}`, (t) =>
            t.setText(details[i][1])
              .setColor(COLORS.text)
              .setFontSize(9)
              .setMargin(2, 0, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });
    }

    // Footer with Watch / Back
    layer.addRow((row) => {
      row.setSize(displayW, 16).setBackgroundColor(COLORS.black);
      const colW = Math.floor(displayW / 2);
      row.addColumn((col) => {
        col.setSize(colW, 16);
        col.addDisplayText('f-watch', (t) =>
          t.setText('\u25cf WATCH')
            .setColor(COLORS.blue)
            .setFontSize(9)
            .setFontWeight('bold')
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
      row.addColumn((col) => {
        col.setSize(colW, 16);
        col.addDisplayText('f-back', (t) =>
          t.setText('\u2717 BACK')
            .setColor(COLORS.textDim)
            .setFontSize(9)
            .setTextAlign('center')
            .setMargin(3, 0, 0, 0)
        );
      });
    });
  }

  getLedColors() {
    return 'dim';
  }
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

module.exports = { SessionsPage };
