const { COLORS, truncate, timeAgo, statusDot } = require('../renderer');

const VISIBLE_ROWS = 6;

class ChannelsPage {
  constructor(state, client, log) {
    this.state = state;
    this.client = client;
    this.log = log;
    this._unsubscribers = [];
  }

  activate() {
    // Fetch current channel status
    this._fetchChannels();
    this._unsubscribers.push(
      this.client.on('channels.changed', () => this._fetchChannels())
    );
  }

  deactivate() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  async _fetchChannels() {
    try {
      const result = await this.client.rpc('channels.status', {});
      const channels = [];
      const accountsByChannel = result.channelAccounts || {};
      const channelOrder = result.channelOrder || Object.keys(accountsByChannel);
      const labels = result.channelLabels || {};

      for (const channelId of channelOrder) {
        const accounts = accountsByChannel[channelId] || [];
        for (const acct of accounts) {
          channels.push({
            channelId,
            name: labels[channelId] || channelId,
            accountId: acct.accountId,
            accountName: acct.name || acct.accountId,
            connected: !!acct.connected,
            enabled: acct.enabled !== false,
            healthState: acct.healthState || (acct.connected ? 'ok' : 'unknown'),
            lastError: acct.lastError || null,
            lastInboundAt: acct.lastInboundAt || null,
            reconnectAttempts: acct.reconnectAttempts || 0,
            activeRuns: acct.activeRuns || 0,
            busy: !!acct.busy,
          });
        }
      }

      this.state.updateChannels({ list: channels });
    } catch (err) {
      this.log.error(`Failed to fetch channels: ${err.message}`);
    }
  }

  // --- Controls ---

  onScroll(value) {
    const maxScroll = Math.max(0, this.state.channels.list.length - VISIBLE_ROWS);
    const offset = Math.round((value / 100) * maxScroll);
    this.state.updateChannels({ scrollOffset: offset });
  }

  onToggle() {
    // Toggle is a future feature — channels.enable/disable may not exist as RPC yet
    this.log.info('Channel toggle not yet implemented');
  }

  // --- Rendering ---

  render(layer, displayW, displayH) {
    const { channels } = this.state;
    const list = channels.list;
    const connectedCount = list.filter((c) => c.connected).length;

    // Header
    layer.addRow((row) => {
      row.setSize(displayW, 18).setBackgroundColor(COLORS.header);
      row.addDisplayText('h-title', (t) =>
        t.setText('CHANNELS')
          .setColor(COLORS.white)
          .setFontSize(11)
          .setFontWeight('bold')
          .setMargin(3, 6, 0, 6)
      );
      row.addDisplayText('h-count', (t) =>
        t.setText(`${connectedCount}/${list.length}`)
          .setColor(connectedCount === list.length ? COLORS.green : COLORS.yellow)
          .setFontSize(10)
          .setTextAlign('right')
          .setMargin(4, 6, 0, 0)
      );
    });

    // Channel rows
    const visible = list.slice(channels.scrollOffset, channels.scrollOffset + VISIBLE_ROWS);
    for (let i = 0; i < VISIBLE_ROWS; i++) {
      const ch = visible[i];
      layer.addRow((row) => {
        row.setSize(displayW, 14).setBackgroundColor(i % 2 === 0 ? COLORS.bg : COLORS.bgAlt);
        if (ch) {
          const dot = statusDot(ch.connected, ch.enabled, ch.healthState, ch.reconnectAttempts);
          const statusText = ch.healthState === 'error'
            ? truncate(ch.lastError || 'error', 12)
            : ch.connected ? 'connected' : ch.enabled ? 'disconnected' : 'disabled';
          const activity = ch.connected ? timeAgo(ch.lastInboundAt) : '';

          row.addColumn((col) => {
            col.setSize(14, 14);
            col.addDisplayText(`dot-${i}`, (t) =>
              t.setText(dot.char)
                .setColor(dot.color)
                .setFontSize(10)
                .setTextAlign('center')
                .setMargin(1, 0, 0, 4)
            );
          });
          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.4), 14);
            col.addDisplayText(`name-${i}`, (t) =>
              t.setText(truncate(ch.name, 14))
                .setColor(COLORS.text)
                .setFontSize(10)
                .setMargin(1, 2, 0, 0)
                .setTextWrap('ellipsis')
            );
          });
          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.35), 14);
            col.addDisplayText(`status-${i}`, (t) =>
              t.setText(statusText)
                .setColor(dot.color)
                .setFontSize(9)
                .setMargin(2, 2, 0, 0)
            );
          });
          row.addColumn((col) => {
            col.setSize(Math.floor(displayW * 0.12), 14);
            col.addDisplayText(`ago-${i}`, (t) =>
              t.setText(activity)
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
      const labels = ['\u25c0 AGENT', '\u25b2\u25bc SCROLL', 'TOGGLE', 'PG \u25b6'];
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

  getLedColors() {
    // Map channels to LED colors
    const list = this.state.channels.list;
    if (list.length === 0) return 'dim';
    const colors = list.map((ch) => {
      if (!ch.enabled) return COLORS.textDim;
      if (ch.healthState === 'error') return COLORS.red;
      if (ch.reconnectAttempts > 0) return COLORS.yellow;
      if (ch.connected) return COLORS.green;
      return COLORS.textDim;
    });
    return colors;
  }
}

module.exports = { ChannelsPage };
