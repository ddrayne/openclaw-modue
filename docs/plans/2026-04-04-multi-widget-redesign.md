# Multi-Widget Display Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single display widget with 6 purpose-built widgets at different sizes, all sharing one OpenClaw WebSocket connection. Each widget is independently draggable onto the Modue device layout.

**Architecture:** One plugin registers multiple `registerDisplay()` calls, each a different widget. A shared singleton manages the WebSocket connection and state. Each display's `registerOnInitializeHandler` grabs a reference to the shared state and starts rendering. Runtime updates use `instance.components.<id>.set(value)`.

**Tech Stack:** Modue SDK display API, Node.js builtins (http, crypto, events)

**SDK Reference (confirmed experimentally):**
- `registerDisplay().setSize(rows, columns)` — NOT (x, y). Max: 8 rows, 2 columns.
- Tile = 60px. So setSize(4, 2) = 240px tall × 120px wide.
- Internal elements: `.setSize(width_px, height_px)` — max 120 × 960.
- Usable width for 2 cols with 4px margin: 112px. With 2px margin: 116px.
- Runtime text update: `instance.components.<name>.set(stringValue)`.
- `setTextWrap('wrap')` enables multi-line wrapping text.
- Font recommendations: 36pt headline, 22-24pt body, 18pt secondary, 14pt caption.

---

### Task 1: Refactor to shared connection singleton

**Files:**
- Modify: `index.js` — extract connection logic into a shared module
- Create: `lib/connection.js` — singleton managing WS connection + state

**Goal:** All widgets share one WebSocket connection. The connection singleton:
- Connects once on first widget init
- Exposes `state` (connected, agent status, current text, channels)
- Emits updates that widgets can subscribe to
- Reads config from `storage.get()`

**Step 1: Create `lib/connection.js`**

```js
const { OpenClawClient } = require('./ws-client');
const { truncate } = require('./renderer');

let instance = null;

class Connection {
  constructor(storage, log) {
    this.storage = storage;
    this.log = log;
    this.client = null;
    this.connected = false;
    this.agentStatus = 'idle';
    this.currentText = '';
    this.pendingApproval = null;
    this.sourceChannel = '';
    this._listeners = [];
  }

  static getInstance(storage, log) {
    if (!instance) instance = new Connection(storage, log);
    return instance;
  }

  connect() {
    const url = this.storage.get('gatewayUrl') || 'ws://127.0.0.1:18789';
    const token = this.storage.get('gatewayToken') || '';
    if (this.client) this.client.disconnect();
    this.client = new OpenClawClient(url, token, this.log);
    // ... wire up event handlers that update this.connected, this.agentStatus, etc.
    // ... call this._notify() on every state change
    this.client.connect();
  }

  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  }

  _notify() {
    for (const fn of this._listeners) { try { fn(this); } catch {} }
  }
}
```

**Step 2: Update `index.js`** to use `Connection.getInstance()` and remove inline WS logic.

**Step 3: Verify plugin loads** — `node -e "require('./index.js')"`, then `sync.sh` and restart Modue.

**Step 4: Commit**
```
git commit -m "refactor: extract shared connection singleton"
```

---

### Task 2: Claw Status widget (1×1 = 60×60px)

**Files:**
- Modify: `index.js` — add `registerDisplay({ name: 'Claw Status' }).setSize(1, 1)`

**Layout (60×60px, 2px margin → 56×56 usable):**
```
┌────────────────┐
│                │
│   🦞 (32pt)    │  Lobster emoji, centered
│                │
│  IDLE (14pt)   │  Status word, centered
│                │
└────────────────┘
```

**Step 1: Register the display**

```js
configuration
  .registerDisplay({ name: 'Claw Status' })
  .setSize(1, 1)
  .addLayer((layer) => {
    layer
      .setMargin(2, 2, 2, 2)
      .setBorderRadius(4, 4, 4, 4)
      .setBackgroundColor('#1a1a2e');
    layer.addRow((row) => {
      row.setSize(56, 34);
      row.addDisplayText('icon', (t) =>
        t.setText('\u{1F99E}')
          .setFontSize(28)
          .setTextAlign('center')
          .setMargin(2, 0, 0, 0)
      );
    });
    layer.addRow((row) => {
      row.setSize(56, 20);
      row.addDisplayText('status', (t) =>
        t.setText('...')
          .setColor('#31e000')
          .setFontSize(12)
          .setFontWeight('bold')
          .setTextAlign('center')
          .setMargin(0, 0, 0, 0)
      );
    });
  })
  .registerOnInitializeHandler((instance) => {
    const dc = instance.components;
    const conn = Connection.getInstance(storage, log);
    conn.onChange(() => {
      dc.status?.set(conn.agentStatus.toUpperCase());
    });
    if (!conn.client) conn.connect();
  });
```

**Step 2: Sync and test** — add widget to Modue, verify lobster + status word displays.

**Step 3: Commit**
```
git commit -m "feat: add Claw Status 1x1 widget"
```

---

### Task 3: Claw Stream widget (2×2 = 120×120px)

**Layout (120×120px, 3px margin → 114×114 usable):**
```
┌──────────────────┐
│ 🦞 RESPONDING    │  Header: 28px — icon + status (18pt bold)
├──────────────────┤
│ Let me check     │
│ the weather      │  Content: 62px — wrapping text (18pt)
│ forecast...      │  setTextWrap('wrap')
├──────────────────┤
│ via Telegram     │  Footer: 20px — source channel (12pt)
└──────────────────┘
```

**Step 1: Register display** — `setSize(2, 2)`, one wrapping text area.

**Step 2: Wire to Connection singleton** — on change, update status + content + channel.

**Step 3: Sync and test.**

**Step 4: Commit**
```
git commit -m "feat: add Claw Stream 2x2 widget"
```

---

### Task 4: Claw Live widget (4×2 = 240×120px)

**Layout (240×120px, 3px margin → 114×234 usable):**
```
┌──────────────────┐
│ 🦞 THINKING...   │  Header: 30px (20pt bold)
├──────────────────┤
│                  │
│ Looking at the   │
│ weather API for  │
│ tomorrow. It     │  Content: 170px — wrapping text (22pt)
│ seems like       │  setTextWrap('wrap')
│ scattered        │  Big readable flowing text
│ showers in the   │
│ morning...       │
│                  │
├──────────────────┤
│ via Telegram     │  Footer: 28px — channel + controls (14pt)
│ ◀ YES    NO ▶   │
└──────────────────┘
```

**Step 1: Register display** — `setSize(4, 2)`.

**Step 2: Wire to Connection.**

**Step 3: Sync and test.**

**Step 4: Commit**
```
git commit -m "feat: add Claw Live 4x2 widget"
```

---

### Task 5: Claw Full widget (8×2 = 480×120px)

**Layout (480×120px, 3px margin → 114×474 usable):**
```
┌──────────────────┐
│                  │
│      🦞 (36pt)   │  Top: 80px — big lobster + status
│   RESPONDING     │  Status word (24pt bold)
│                  │
├──────────────────┤
│                  │
│ Let me check the │
│ weather forecast │
│ for tomorrow in  │
│ London.          │
│                  │  Content: 350px — wrapping text (22pt)
│ It looks like    │  Full paragraphs visible
│ there will be    │  setTextWrap('wrap')
│ scattered        │
│ showers in the   │
│ morning,         │
│ clearing by      │
│ afternoon with   │
│ highs around     │
│ 18°C.            │
│                  │
├──────────────────┤
│ via Telegram     │  Footer: 38px — channel + controls (16pt)
│ ◀ YES    NO ▶   │
└──────────────────┘
```

**Step 1: Register display** — `setSize(8, 2)`.

**Step 2: Wire to Connection.**

**Step 3: Sync and test.**

**Step 4: Commit**
```
git commit -m "feat: add Claw Full 8x2 widget"
```

---

### Task 6: Channels widget (1×2 = 60×120px)

**Layout (60×120px, 2px margin → 56×116 usable):**
```
┌────────────────┐
│  CHANNELS      │  Header: 20px (12pt bold)
├────────────────┤
│ ● WhatsApp     │
│ ● Telegram     │  List: 88px — channel names (12pt)
│ ○ Discord      │  setTextWrap('wrap')
│ ● Slack        │  Green dot = connected
│                │
├────────────────┤
│ 3/4            │  Footer: 16px — count (12pt)
└────────────────┘
```

Note: 1 column = 60px wide so text will be tight. Use short channel names.

**Step 1: Register display** — `setSize(2, 1)` (2 rows, 1 col).

Wait — `setSize(rows, cols)`. For 1 column wide and 2 rows tall: `setSize(2, 1)`. That gives 120px tall × 60px wide. ✓

**Step 2: Wire to Connection, fetch channels.status on init.**

**Step 3: Commit**
```
git commit -m "feat: add Channels widget"
```

---

### Task 7: Approval widget (1×2 = 60×120px)

**Layout (60×120px, 2px margin → 56×116 usable):**
```
┌────────────────┐
│                │
│     ⚠️         │  Icon: 40px — warning icon or ✓ (28pt)
│                │
├────────────────┤
│ rm -rf /tmp/*  │  Command: 50px — wrapping text (12pt)
│                │
├────────────────┤
│  ◀ Y    N ▶   │  Controls: 20px (12pt)
└────────────────┘
```

Shows ⚠️ when approval pending, ✓ when idle. Dormant when nothing to approve.

**Step 1: Register display** — `setSize(2, 1)`.

**Step 2: Wire to Connection, listen for approval events.**

**Step 3: Commit**
```
git commit -m "feat: add Approval widget"
```

---

### Task 8: Clean up and wire index.js

**Files:**
- Modify: `index.js` — import all widgets, register config + keys + knob + LEDs once
- Remove: unused page files in `lib/pages/`

**Step 1:** Single `index.js` that registers: config, all 6 displays, keys, knob, LEDs.

**Step 2:** Keys/knob/LEDs respond to shared Connection state.

**Step 3:** Remove `lib/pages/` directory (no longer needed).

**Step 4:** Bump version to 0.5.0, update sync.sh.

**Step 5: Commit**
```
git commit -m "feat: wire all widgets, clean up old code"
```

---

### Task 9: Sync, test, push

**Step 1:** Run `sync.sh`, force quit Modue, restart.

**Step 2:** Add each widget to the device layout one by one, verify:
- Claw Status: shows lobster + status word
- Claw Stream: shows header + streaming text + channel
- Claw Live: shows header + large streaming text + channel + controls
- Claw Full: shows big lobster + full text + channel + controls
- Channels: shows channel list with connection dots
- Approval: shows idle, then lights up on exec approval

**Step 3:** Trigger an agent run from Telegram/CLI and verify streaming text appears.

**Step 4:** Push to GitHub.
```
git push
```

---

### Verification

1. **Load test:** All 6 widgets load without errors in Modue logs
2. **Connection:** Dev log shows "Connected to OpenClaw gateway"  
3. **Status:** Each widget shows IDLE when connected with no activity
4. **Streaming:** Send a message via Telegram → text streams across all active widgets
5. **Approval:** Trigger a command needing approval → approval widget lights up, keys work
6. **Channels:** Shows correct channel list with connection status
7. **Layout:** Text is readable (18-24pt), wraps properly, uses full width
