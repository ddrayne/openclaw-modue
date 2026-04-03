const { COLORS, truncate } = require('../renderer');

const MAX_SLOTS = 5;

class CommandsPage {
  constructor(state, client, log, storage) {
    this.state = state;
    this.client = client;
    this.log = log;
    this.storage = storage;
    this.executing = {}; // slot index -> 'running' | 'success' | 'error'
    this._unsubscribers = [];
  }

  activate() {
    this._loadSlots();
  }

  deactivate() {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers = [];
  }

  _loadSlots() {
    const saved = this.storage.get('commandSlots');
    if (saved) {
      try {
        const slots = JSON.parse(saved);
        this.state.commands.slots = slots.slice(0, MAX_SLOTS);
      } catch {
        this.state.commands.slots = [];
      }
    }
    this.state._notify();
  }

  saveSlots(slots) {
    this.state.commands.slots = slots.slice(0, MAX_SLOTS);
    this.storage.set('commandSlots', JSON.stringify(this.state.commands.slots));
    this.state._notify();
  }

  // --- Controls ---

  async onKey(slotIndex) {
    const slot = this.state.commands.slots[slotIndex];
    if (!slot) {
      this.log.info(`No command bound to slot ${slotIndex + 1}`);
      return;
    }

    this.executing[slotIndex] = 'running';
    this.state._notify();

    try {
      switch (slot.actionType) {
        case 'cron.run': {
          await this.client.rpc('cron.run', {
            id: slot.params.jobId,
            mode: 'force',
          });
          break;
        }
        case 'agent': {
          await this.client.rpc('agent', {
            message: slot.params.message,
            sessionKey: slot.params.sessionKey || undefined,
          });
          break;
        }
        case 'health': {
          await this.client.rpc('health', {});
          break;
        }
        case 'logs.tail': {
          // Just trigger a logs request — the display could show last log line
          await this.client.rpc('logs.tail', { limit: 5 });
          break;
        }
        default:
          this.log.warn(`Unknown action type: ${slot.actionType}`);
      }
      this.executing[slotIndex] = 'success';
    } catch (err) {
      this.log.error(`Command slot ${slotIndex + 1} failed: ${err.message}`);
      this.executing[slotIndex] = 'error';
    }

    this.state._notify();

    // Clear execution status after 2 seconds
    setTimeout(() => {
      delete this.executing[slotIndex];
      this.state._notify();
    }, 2000);
  }

  // --- Rendering ---

  render(layer, displayW, displayH) {
    const { commands } = this.state;

    // Header
    layer.addRow((row) => {
      row.setSize(displayW, 18).setBackgroundColor(COLORS.header);
      row.addDisplayText('h-title', (t) =>
        t.setText('COMMANDS')
          .setColor(COLORS.white)
          .setFontSize(11)
          .setFontWeight('bold')
          .setMargin(3, 6, 0, 6)
      );
    });

    // Command slot rows
    for (let i = 0; i < MAX_SLOTS; i++) {
      const slot = commands.slots[i];
      const execState = this.executing[i];

      layer.addRow((row) => {
        row.setSize(displayW, 14).setBackgroundColor(i % 2 === 0 ? COLORS.bg : COLORS.bgAlt);

        // Key number indicator
        row.addColumn((col) => {
          col.setSize(24, 14);
          const indicatorColor = execState === 'running' ? COLORS.amber
            : execState === 'success' ? COLORS.green
            : execState === 'error' ? COLORS.red
            : COLORS.textDim;
          col.addDisplayText(`k-${i}`, (t) =>
            t.setText(`[${i + 1}]`)
              .setColor(indicatorColor)
              .setFontSize(10)
              .setFontWeight('bold')
              .setMargin(1, 4, 0, 4)
          );
        });

        // Label
        row.addColumn((col) => {
          col.setSize(displayW - 24, 14);
          col.addDisplayText(`lbl-${i}`, (t) =>
            t.setText(slot ? truncate(slot.label, 30) : '(empty)')
              .setColor(slot ? COLORS.text : COLORS.textDim)
              .setFontSize(10)
              .setMargin(1, 4, 0, 0)
              .setTextWrap('ellipsis')
          );
        });
      });
    }

    // Spacer row
    layer.addRow((row) => {
      row.setSize(displayW, 14).setBackgroundColor(COLORS.bg);
      row.addDisplayText('spacer', (t) =>
        t.setText('Configure in Modue settings')
          .setColor(COLORS.textDim)
          .setFontSize(8)
          .setMargin(3, 6, 0, 6)
      );
    });

    // Footer
    layer.addRow((row) => {
      row.setSize(displayW, 16).setBackgroundColor(COLORS.black);
      row.addColumn((col) => {
        col.setSize(displayW, 16);
        col.addDisplayText('f-nav', (t) =>
          t.setText('\u25c0 SESSIONS')
            .setColor(COLORS.textDim)
            .setFontSize(8)
            .setTextAlign('center')
            .setMargin(4, 0, 0, 0)
        );
      });
    });
  }

  getLedColors() {
    const colors = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const exec = this.executing[i];
      if (exec === 'running') colors.push(COLORS.amber);
      else if (exec === 'success') colors.push(COLORS.green);
      else if (exec === 'error') colors.push(COLORS.red);
      else colors.push(COLORS.textDim);
    }
    return colors;
  }
}

module.exports = { CommandsPage };
