# Display Improvements — Ambient Mode, Agent Control & Physical Controls

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Modue from a passive agent-activity viewer into an always-useful ambient dashboard + fully agent-controllable hardware surface.

**Architecture:** Three phases. Phase 1 adds ambient mode (system stats, last activity, connection health) using the SDK's built-in `useSystemMonitorResources` — no gateway changes needed. Phase 2 wires up physical controls (slider, knob, keys) with bidirectional gateway communication via new `modue.*` protocol frames. Phase 3 adds agent display control — OpenClaw can push faces, images, text, and full layouts to any widget.

**Tech Stack:** Modue SDK display API (`useSystemMonitorResources`, `addDisplayImage`, `setIsIcon`, touch handlers), Node.js builtins, OpenClaw gateway (TypeScript, `@sinclair/typebox` schemas, WebSocket frames)

---

## Phase 1: Ambient Mode (Plugin Only)

### Task 1: Add system stats to Connection singleton

**Files:**
- Modify: `lib/connection.js` — add system resource state properties
- Modify: `index.js` — wire `useSystemMonitorResources` on a widget and relay to Connection
- Test: `test/connection.test.js` — test system stats state updates

The SDK provides `useSystemMonitorResources(handler)` on any widget. We register it on the LED cluster (already initialized early) and relay the data into the Connection singleton so all display widgets can read it.

**Step 1: Write failing test**

Add to `test/connection.test.js`:

```js
describe('System stats', () => {
  it('stores system stats when updateSystemStats is called', () => {
    const conn = freshConnection();
    conn.updateSystemStats({
      cpu: { usageInPercentage: 34, temperatureInCelsius: 52, clockInMhz: 3200, fanSpeedInRpm: 1200 },
      gpu: { usageInPercentage: 10, temperatureInCelsius: 45, clockInMhz: 1500, fanSpeedInRpm: 0 },
      ram: { usageInPercentage: 61 },
      disk: { storageUsedInPercentage: 45 },
      network: { download: 12, upload: 3 },
    });
    assert.equal(conn.systemStats.cpu, 34);
    assert.equal(conn.systemStats.ram, 61);
    assert.equal(conn.systemStats.disk, 45);
    assert.equal(conn.systemStats.cpuTemp, 52);
    assert.equal(conn.systemStats.netDown, 12);
    assert.equal(conn.systemStats.netUp, 3);
  });

  it('notifies subscribers on system stats update', () => {
    const conn = freshConnection();
    let called = false;
    conn.onChange(() => { called = true; });
    conn.updateSystemStats({
      cpu: { usageInPercentage: 50, temperatureInCelsius: 60, clockInMhz: 3200, fanSpeedInRpm: 1200 },
      gpu: { usageInPercentage: 0, temperatureInCelsius: 0, clockInMhz: 0, fanSpeedInRpm: 0 },
      ram: { usageInPercentage: 70 },
      disk: { storageUsedInPercentage: 80 },
      network: { download: 100, upload: 50 },
    });
    assert.ok(called);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: FAIL — `conn.updateSystemStats is not a function`

**Step 3: Implement `updateSystemStats` in Connection**

Add to `lib/connection.js`, in the constructor:

```js
// System stats (from SDK useSystemMonitorResources)
this.systemStats = {
  cpu: 0, cpuTemp: 0,
  gpu: 0, gpuTemp: 0,
  ram: 0, disk: 0,
  netDown: 0, netUp: 0,
};
```

Add method:

```js
/** Update system resource stats (called from SDK useSystemMonitorResources handler). */
updateSystemStats(resources) {
  if (!resources) return;
  this.systemStats.cpu = resources.cpu?.usageInPercentage ?? 0;
  this.systemStats.cpuTemp = resources.cpu?.temperatureInCelsius ?? 0;
  this.systemStats.gpu = resources.gpu?.usageInPercentage ?? 0;
  this.systemStats.gpuTemp = resources.gpu?.temperatureInCelsius ?? 0;
  this.systemStats.ram = resources.ram?.usageInPercentage ?? 0;
  this.systemStats.disk = resources.disk?.storageUsedInPercentage ?? 0;
  // macOS uses flat download/upload, Windows uses wifi/ethernet sub-objects
  this.systemStats.netDown = resources.network?.download ?? resources.network?.wifi?.downloadInKbs ?? 0;
  this.systemStats.netUp = resources.network?.upload ?? resources.network?.wifi?.uploadInKbs ?? 0;
  this._notify();
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: All PASS

**Step 5: Wire `useSystemMonitorResources` in index.js**

In `index.js`, on the LED cluster registration, chain `.useSystemMonitorResources()`:

```js
configuration
  .registerLedCluster({ name: 'Status' })
  .useSystemMonitorResources((resources, _instance) => {
    try {
      const conn = Connection.getInstance(storage, log);
      conn.updateSystemStats(resources);
    } catch (_) { /* noop */ }
  })
  .registerOnInitializeHandler((instance) => {
    // ... existing LED init code
  })
  // ... rest of LED handlers
```

**Step 6: Commit**

```
git commit -m "feat: add system stats to Connection via SDK useSystemMonitorResources"
```

---

### Task 2: Add displayMode and last activity tracking to Connection

**Files:**
- Modify: `lib/connection.js` — add `displayMode`, `lastActivity` properties
- Test: `test/connection.test.js` — test mode transitions and last activity capture

**Step 1: Write failing test**

```js
describe('Display mode', () => {
  it('starts in ambient mode', () => {
    const conn = freshConnection();
    assert.equal(conn.displayMode, 'ambient');
  });

  it('switches to streaming when agent starts', () => {
    const { conn, client } = connectedPair();
    client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
    assert.equal(conn.displayMode, 'streaming');
  });

  it('returns to ambient when agent ends', () => {
    const { conn, client } = connectedPair();
    client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' } });
    client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
    assert.equal(conn.displayMode, 'ambient');
  });

  it('switches to approval when exec approval arrives', () => {
    const { conn, client } = connectedPair();
    client.emit('exec.approval.requested', { id: 'a1', request: { command: 'ls' } });
    assert.equal(conn.displayMode, 'approval');
  });
});

describe('Last activity', () => {
  it('captures last activity when agent lifecycle ends', () => {
    const { conn, client } = connectedPair();
    client.emit('agent', { stream: 'lifecycle', data: { phase: 'start' }, channel: 'telegram', sender: 'Dan' });
    client.emit('agent', { stream: 'assistant', data: { delta: 'Hello there!' } });
    client.emit('agent', { stream: 'lifecycle', data: { phase: 'end' } });
    assert.ok(conn.lastActivity);
    assert.equal(conn.lastActivity.channel, 'telegram');
    assert.equal(conn.lastActivity.sender, 'Dan');
    assert.ok(conn.lastActivity.endedAt > 0);
    assert.ok(conn.lastActivity.summary.length > 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: FAIL

**Step 3: Implement displayMode and lastActivity**

In `lib/connection.js` constructor, add:

```js
this.displayMode = 'ambient';  // ambient | streaming | agent | approval
this.lastActivity = null;      // { summary, channel, sender, endedAt }
```

In `_setStatus()`, manage `displayMode`:

```js
_setStatus(status) {
  const prev = this.agentStatus;
  this.agentStatus = status;
  this._refreshMoodColor();

  // Update display mode
  if (status === 'idle' || status === 'offline') {
    // Only go ambient if not in agent-controlled mode
    if (this.displayMode !== 'agent') {
      this.displayMode = 'ambient';
    }
  } else if (this.pendingApproval) {
    this.displayMode = 'approval';
  } else {
    this.displayMode = 'streaming';
  }

  // ... rest of existing _setStatus logic
}
```

In `_handleLifecycle()`, capture last activity on `phase: 'end'`:

```js
} else if (phase === 'end') {
  this._stopElapsedTimer();
  // Capture last activity before clearing state
  this.lastActivity = {
    summary: this._extractDisplayText(this._rawBuffer).slice(0, 120) || 'Completed task',
    channel: this.sourceChannel,
    sender: this.sourceSender,
    endedAt: Date.now(),
  };
  this._setStatus('idle');
}
```

Update approval handler to set displayMode:

```js
c.on('exec.approval.requested', (payload) => {
  // ... existing code ...
  this.displayMode = 'approval';
  this._notify();
});
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: All PASS

**Step 5: Commit**

```
git commit -m "feat: add displayMode and lastActivity tracking to Connection"
```

---

### Task 3: Add connection health tracking

**Files:**
- Modify: `lib/connection.js` — add uptime, reconnect count, latency tracking
- Test: `test/connection.test.js`

**Step 1: Write failing test**

```js
describe('Connection health', () => {
  it('tracks connected timestamp', () => {
    const { conn, client } = connectedPair();
    client.emit('connection', { connected: true });
    assert.ok(conn.health.connectedSince > 0);
  });

  it('increments reconnect count', () => {
    const { conn, client } = connectedPair();
    client.emit('connection', { connected: true });
    client.emit('connection', { connected: false });
    client.emit('connection', { connected: true });
    assert.equal(conn.health.reconnects, 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: FAIL

**Step 3: Implement health tracking**

In `lib/connection.js` constructor, add:

```js
this.health = {
  connectedSince: 0,  // timestamp of current connection
  reconnects: 0,      // number of reconnections
  wasConnected: false, // track if we've been connected before (for reconnect counting)
};
```

In `_wireEvents()`, update the `connection` handler:

```js
c.on('connection', (info) => {
  this.connected = info.connected;
  if (info.connected) {
    if (this.health.wasConnected) {
      this.health.reconnects++;
    }
    this.health.connectedSince = Date.now();
    this.health.wasConnected = true;
    this._setStatus('idle');
    this.currentText = 'Connected. Waiting for activity...';
  } else {
    this._setStatus('offline');
    this.currentText = 'Disconnected. Reconnecting...';
  }
  this._notify();
});
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: All PASS

**Step 5: Commit**

```
git commit -m "feat: add connection health tracking (uptime, reconnects)"
```

---

### Task 4: Add ambient rendering helpers to renderer.js

**Files:**
- Modify: `lib/renderer.js` — add formatting functions for ambient display content

**Step 1: Add ambient formatting helpers**

Add to `lib/renderer.js`:

```js
/**
 * Format system stats for a given display width.
 * 'compact' = single line: "CPU 34% RAM 61%"
 * 'full' = multi-line with bars and temp
 */
function formatSystemStats(stats, mode) {
  if (!stats) return '';
  if (mode === 'compact') {
    return `CPU ${stats.cpu}%  RAM ${stats.ram}%`;
  }
  // full mode — multi-line
  const lines = [];
  lines.push(`CPU  ${String(stats.cpu).padStart(3)}%  ${_bar(stats.cpu)}  ${stats.cpuTemp ? stats.cpuTemp + '\u00B0C' : ''}`);
  lines.push(`RAM  ${String(stats.ram).padStart(3)}%  ${_bar(stats.ram)}`);
  lines.push(`Disk ${String(stats.disk).padStart(3)}%  ${_bar(stats.disk)}`);
  const down = stats.netDown >= 1000 ? `${(stats.netDown / 1000).toFixed(1)} MB/s` : `${Math.round(stats.netDown)} KB/s`;
  const up = stats.netUp >= 1000 ? `${(stats.netUp / 1000).toFixed(1)} MB/s` : `${Math.round(stats.netUp)} KB/s`;
  lines.push(`Net  \u2193${down}  \u2191${up}`);
  return lines.join('\n');
}

function _bar(pct) {
  const filled = Math.round((pct / 100) * 6);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(6 - filled);
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
```

Update exports:

```js
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
```

**Step 2: Commit**

```
git commit -m "feat: add ambient display formatting helpers"
```

---

### Task 5: Update Claw Status widget (1x1) for ambient mode

**Files:**
- Modify: `lib/widgets.js` — update `registerClawStatus` to show ambient content when idle

The 1x1 widget (120x120px) shows: lobster icon, status when active, or compact stats when idle.

**Step 1: Update the widget**

In `lib/widgets.js`, modify the `bindDisplay` callback in `registerClawStatus`:

```js
unsub = bindDisplay(conn, dc, (c, d) => {
  if (c.displayMode === 'ambient') {
    d.status?.set(formatSystemStats(c.systemStats, 'compact'));
    d.detail?.set(formatHealth(c.health, c.connected));
  } else {
    d.status?.set(c.statusPhrase);
    d.detail?.set(c.statusDetail || '');
  }
});
```

Add import at top of widgets.js:

```js
const { COLORS, formatSystemStats, formatHealth } = require('./renderer');
```

**Step 2: Sync and test on device** — verify the 1x1 tile shows "CPU 34% RAM 61%" and connection health when idle, switches to status phrase when agent is active.

**Step 3: Commit**

```
git commit -m "feat: ambient mode for Claw Status widget"
```

---

### Task 6: Update Claw Stream widget (2x2) for ambient mode

**Files:**
- Modify: `lib/widgets.js` — update `registerClawStream`

The 2x2 widget (240x240px) has header (36px), content (168px), footer (30px). In ambient mode:

```
┌────────────────────────┐
│ 🦞 idle                │  Header: status
├────────────────────────┤
│ Dan via Telegram       │  Last activity (who + when)
│ 4m ago                 │
│                        │
│ CPU 34%  RAM 61%       │  Compact stats
│ Disk 45%               │
│ ↓12 ↑3 KB/s           │
├────────────────────────┤
│ ● up 2h · 0 reconn    │  Connection health
└────────────────────────┘
```

**Step 1: Update the widget**

```js
unsub = bindDisplay(conn, dc, (c, d) => {
  d.status?.set(c.statusPhrase);
  if (c.displayMode === 'ambient') {
    const activity = formatLastActivity(c.lastActivity);
    const stats = formatSystemStats(c.systemStats, 'compact');
    d.content?.set(`${activity}\n\n${stats}`);
    d.footer?.set(formatHealth(c.health, c.connected));
  } else {
    d.content?.set(c.displayText || 'Waiting...');
    d.footer?.set(formatSource(c));
  }
});
```

Add `formatLastActivity` to the import from renderer.

**Step 2: Sync and test on device.**

**Step 3: Commit**

```
git commit -m "feat: ambient mode for Claw Stream widget"
```

---

### Task 7: Update Claw Live widget (4x2) for ambient mode

**Files:**
- Modify: `lib/widgets.js` — update `registerClawLive`

The 4x2 widget (240x480px) has room for full stats display.

**Step 1: Update the widget**

```js
unsub = bindDisplay(conn, dc, (c, d) => {
  d.status?.set(c.statusPhrase);
  if (c.displayMode === 'ambient') {
    const activity = formatLastActivity(c.lastActivity);
    const stats = formatSystemStats(c.systemStats, 'full');
    d.content?.set(`LAST ACTIVITY\n${activity}\n\nSYSTEM\n${stats}`);
    d.elapsed?.set('');
    d.footer?.set(formatHealth(c.health, c.connected));
  } else {
    d.elapsed?.set(c.statusDetail || '');
    d.content?.set(c.displayText || 'Waiting for activity...');
    const src = formatSource(c);
    const ctrl = formatControls(c);
    const suffix = [src, ctrl].filter(Boolean).join(' \u2022 ');
    d.footer?.set(suffix);
  }
});
```

**Step 2: Sync and test on device.**

**Step 3: Commit**

```
git commit -m "feat: ambient mode for Claw Live widget"
```

---

### Task 8: Update Claw Full widget (8x2) for ambient mode

**Files:**
- Modify: `lib/widgets.js` — update `registerClawFull`

Same pattern as Claw Live but with `'full'` stats and larger content area.

**Step 1: Update the widget** — same approach as Task 7 but targeting `registerClawFull`.

**Step 2: Sync and test on device.**

**Step 3: Commit**

```
git commit -m "feat: ambient mode for Claw Full widget"
```

---

### Task 9: Repurpose Approval widget as mini system monitor when idle

**Files:**
- Modify: `lib/widgets.js` — update `registerApproval`

When no approval pending, show compact system stats instead of "all clear":

```
┌──────────────┐
│              │
│  CPU  34%    │
│  RAM  61%    │
│  Disk 45%    │
│  52°C        │
│              │
├──────────────┤
│              │
└──────────────┘
```

**Step 1: Update the widget**

```js
unsub = bindDisplay(conn, dc, (c, d) => {
  if (c.pendingApproval) {
    const risk = c.pendingApproval.risk || 'low';
    d['ap-icon']?.set(risk === 'HIGH' ? '\u{1F6A8}' : '\u26A0');
    d['ap-cmd']?.set(`[${risk}] ${c.pendingApproval.command || '?'}`);
    d['ap-ctrl']?.set('\u25C0 YES    NO \u25B6');
  } else {
    const s = c.systemStats;
    d['ap-icon']?.set('');
    d['ap-cmd']?.set(`CPU  ${s.cpu}%\nRAM  ${s.ram}%\nDisk ${s.disk}%\n${s.cpuTemp ? s.cpuTemp + '\u00B0C' : ''}`);
    d['ap-ctrl']?.set('');
  }
});
```

**Step 2: Sync and test on device.**

**Step 3: Commit**

```
git commit -m "feat: approval widget shows system stats when idle"
```

---

### Task 10: Phase 1 integration test and cleanup

**Step 1:** Run full test suite: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`
Expected: All PASS

**Step 2:** Sync to device, restart Modue, verify:
- All widgets show ambient content when idle (stats, last activity, health)
- When agent starts working, widgets switch to streaming text
- When agent finishes, widgets return to ambient with updated "last activity"
- Approval overrides everything, returns to ambient when resolved

**Step 3: Commit**

```
git commit -m "chore: phase 1 complete — ambient mode"
```

---

## Phase 2: Physical Controls (Plugin + Gateway)

### Task 11: Register slider widget and wire bidirectionally

**Files:**
- Modify: `index.js` — add `registerSlider`, handle `modue.slider.set` frames from gateway, send `modue.slider.changed` events
- Modify: `lib/connection.js` — add `sliderValue` state, `setSlider()` method, listen for `modue.slider.set` frames

**Step 1: Write failing test**

Add to `test/connection.test.js`:

```js
describe('Slider', () => {
  it('stores slider value from gateway', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.slider.set', { value: 75 });
    assert.equal(conn.sliderValue, 75);
  });

  it('notifies on slider change', () => {
    const { conn, client } = connectedPair();
    let notified = false;
    conn.onChange(() => { notified = true; });
    client.emit('modue.slider.set', { value: 50 });
    assert.ok(notified);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/dan/code/modue/openclaw-modue && node --test test/connection.test.js`

**Step 3: Implement slider state in Connection**

In constructor:
```js
this.sliderValue = 0;
this._sliderInstance = null; // set by index.js when slider initializes
```

In `_wireEvents()`:
```js
c.on('modue.slider.set', (payload) => {
  if (payload && typeof payload.value === 'number') {
    this.sliderValue = Math.max(0, Math.min(100, payload.value));
    if (this._sliderInstance) {
      try { this._sliderInstance.set(this.sliderValue); } catch (_) {}
    }
    this._notify();
  }
});
```

Add method to send slider changes to gateway:
```js
sendSliderChanged(value) {
  if (!this._client) return;
  this._client.rpc('modue.slider.changed', { value });
}
```

**Step 4: Run test to verify passes**

**Step 5: Register slider in index.js**

```js
configuration
  .registerSlider({ name: 'OpenClaw' })
  .registerOnInitializeHandler((instance) => {
    const conn = Connection.getInstance(storage, log);
    conn._sliderInstance = instance;
    ensureConnected(conn);
  })
  .registerOnChangeHandler((value, _instance) => {
    const conn = Connection.getInstance(storage, log);
    conn.sendSliderChanged(value);
  })
  .registerOnDeactivateHandler(() => {
    try { Connection.getInstance()._sliderInstance = null; } catch (_) {}
  });
```

Import `ensureConnected` from widgets.js or inline it. It's currently defined in widgets.js — move it to connection.js as a method or export it.

**Step 6: Commit**

```
git commit -m "feat: register slider, bidirectional gateway control"
```

---

### Task 12: Wire knob to send events to gateway

**Files:**
- Modify: `index.js` — update knob handler to send `modue.knob.changed`

**Step 1: Update knob registration**

Replace the existing knob handler in `index.js`:

```js
configuration
  .registerKnob({ name: 'Scroll' })
  .registerOnChangeHandler((value) => {
    const conn = Connection.getInstance(storage, log);
    conn.rpc('modue.knob.changed', { value }).catch(() => {});
  });
```

**Step 2: Sync and test** — turn knob, verify gateway receives `modue.knob.changed` in logs.

**Step 3: Commit**

```
git commit -m "feat: wire knob to send modue.knob.changed events"
```

---

### Task 13: Wire keys with dynamic labels and gateway events

**Files:**
- Modify: `lib/connection.js` — add `keyLabels` state, listen for `modue.key.labels` frames
- Modify: `index.js` — update key handlers to send `modue.key.pressed` events
- Modify: `lib/widgets.js` — show key labels in widget footers
- Test: `test/connection.test.js`

**Step 1: Write failing test**

```js
describe('Key labels', () => {
  it('stores key labels from gateway', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.key.labels', { left: 'Approve', center: 'Talk', right: 'Skip' });
    assert.equal(conn.keyLabels.left, 'Approve');
    assert.equal(conn.keyLabels.center, 'Talk');
    assert.equal(conn.keyLabels.right, 'Skip');
  });

  it('defaults key labels when idle', () => {
    const conn = freshConnection();
    assert.equal(conn.keyLabels.left, '');
    assert.equal(conn.keyLabels.center, '');
    assert.equal(conn.keyLabels.right, '');
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement key labels in Connection**

In constructor:
```js
this.keyLabels = { left: '', center: '', right: '' };
```

In `_wireEvents()`:
```js
c.on('modue.key.labels', (payload) => {
  if (payload) {
    if (payload.left !== undefined) this.keyLabels.left = String(payload.left);
    if (payload.center !== undefined) this.keyLabels.center = String(payload.center);
    if (payload.right !== undefined) this.keyLabels.right = String(payload.right);
    this._notify();
  }
});
```

**Step 4: Run test to verify passes**

**Step 5: Update key handlers in index.js**

```js
configuration
  .registerKey({ name: 'Left' })
  .registerOnKeyDownHandler(() => {
    const conn = Connection.getInstance(storage, log);
    if (conn.pendingApproval) {
      conn.approveExec();
    } else {
      conn.rpc('modue.key.pressed', { key: 'left' }).catch(() => {});
    }
  });

configuration
  .registerKey({ name: 'Right' })
  .registerOnKeyDownHandler(() => {
    const conn = Connection.getInstance(storage, log);
    if (conn.pendingApproval) {
      conn.denyExec();
    } else {
      conn.rpc('modue.key.pressed', { key: 'right' }).catch(() => {});
    }
  });

configuration
  .registerKey({ name: 'Center' })
  .registerOnKeyDownHandler(() => {
    const conn = Connection.getInstance(storage, log);
    conn.rpc('modue.key.pressed', { key: 'center' }).catch(() => {});
  });
```

**Step 6: Update widget footers to show key labels**

In widgets.js, update footer rendering for Claw Live and Claw Full:

```js
// In the ambient branch of footer rendering:
const labels = [c.keyLabels.left, c.keyLabels.center, c.keyLabels.right].filter(Boolean);
const labelText = labels.length ? labels.join(' \u2022 ') : '';
d.footer?.set(labelText || formatHealth(c.health, c.connected));
```

**Step 7: Commit**

```
git commit -m "feat: dynamic key labels + modue.key.pressed events"
```

---

### Task 14: Wire LED patterns from gateway

**Files:**
- Modify: `lib/connection.js` — add `ledOverride` state, listen for `modue.leds.*` frames
- Test: `test/connection.test.js`

**Step 1: Write failing test**

```js
describe('LED control', () => {
  it('stores direct LED colors from gateway', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.leds.set', { colors: ['#FF0000FF', '#00FF00FF'] });
    assert.deepEqual(conn.ledOverride.colors, ['#FF0000FF', '#00FF00FF']);
  });

  it('stores LED pattern from gateway', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.leds.pattern', { pattern: 'breathe', color: '#4488ff', speed: 5 });
    assert.equal(conn.ledOverride.pattern, 'breathe');
    assert.equal(conn.ledOverride.color, '#4488ff');
  });

  it('clears LED override on release', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.leds.set', { colors: ['#FF0000FF'] });
    client.emit('modue.leds.release', {});
    assert.equal(conn.ledOverride, null);
  });
});
```

**Step 2: Run test to verify fails**

**Step 3: Implement LED override in Connection**

In constructor:
```js
this.ledOverride = null; // null = default behavior, or { colors: [...] } or { pattern, color, speed }
```

In `_wireEvents()`:
```js
c.on('modue.leds.set', (payload) => {
  if (payload?.colors) {
    this.ledOverride = { colors: payload.colors };
    this._notify();
  }
});

c.on('modue.leds.pattern', (payload) => {
  if (payload?.pattern) {
    this.ledOverride = {
      pattern: payload.pattern,
      color: payload.color || '#ffffff',
      speed: payload.speed || 5,
    };
    this._notify();
  }
});

c.on('modue.leds.release', () => {
  this.ledOverride = null;
  this._notify();
});
```

Update `getLedColors()` to check override first:

```js
getLedColors(numLeds, animFrame) {
  const n = numLeds || 8;
  const frame = animFrame || 0;

  // Agent override — direct colors
  if (this.ledOverride?.colors) {
    const c = this.ledOverride.colors;
    return Array.from({ length: n }, (_, i) => c[i % c.length] || null);
  }

  // Agent override — pattern
  if (this.ledOverride?.pattern) {
    return this._patternColors(n, frame, this.ledOverride);
  }

  // Default status-based behavior (existing code)
  const even = frame % 2 === 0;
  if (this.pendingApproval) {
    return Array(n).fill(even ? '#ff9900FF' : '#00000000');
  }
  // ... rest of existing switch
}

_patternColors(n, frame, override) {
  const { pattern, color, speed } = override;
  const cycle = Math.floor(frame * (speed / 5));
  switch (pattern) {
    case 'solid':
      return Array(n).fill(`${color}FF`);
    case 'flash': {
      const on = cycle % 2 === 0;
      return Array(n).fill(on ? `${color}FF` : '#00000000');
    }
    case 'pulse': {
      const alpha = Math.abs(Math.sin(cycle * 0.3));
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      return Array(n).fill(`${color}${hex}`);
    }
    case 'breathe': {
      const brightness = (Math.sin(cycle * 0.15) + 1) / 2;
      const hex = Math.round(brightness * 255).toString(16).padStart(2, '0');
      return Array(n).fill(`${color}${hex}`);
    }
    case 'chase': {
      const active = cycle % n;
      return Array.from({ length: n }, (_, i) => i === active ? `${color}FF` : `${color}22`);
    }
    default:
      return Array(n).fill(`${color}FF`);
  }
}
```

**Step 4: Run tests to verify passes**

**Step 5: Commit**

```
git commit -m "feat: agent-controlled LED colors and patterns"
```

---

## Phase 3: Agent Display Control (Plugin + Gateway)

### Task 15: Handle `modue.display.set` (high-level slots) in Connection

**Files:**
- Modify: `lib/connection.js` — add `agentDisplay` state, listen for `modue.display.*` frames
- Test: `test/connection.test.js`

**Step 1: Write failing test**

```js
describe('Agent display control', () => {
  it('enters agent mode on modue.display.set', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.display.set', { title: 'Deploying...', body: 'Pushing v2.3.1' });
    assert.equal(conn.displayMode, 'agent');
    assert.equal(conn.agentDisplay.title, 'Deploying...');
    assert.equal(conn.agentDisplay.body, 'Pushing v2.3.1');
  });

  it('stores face as Material Symbol name', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.display.set', { face: 'sentiment_satisfied' });
    assert.equal(conn.agentDisplay.face, 'sentiment_satisfied');
  });

  it('stores image as base64', () => {
    const { conn, client } = connectedPair();
    const img = 'data:image/png;base64,iVBOR...';
    client.emit('modue.display.set', { image: img });
    assert.equal(conn.agentDisplay.image, img);
  });

  it('returns to ambient on modue.display.release', () => {
    const { conn, client } = connectedPair();
    client.emit('modue.display.set', { title: 'Hello' });
    assert.equal(conn.displayMode, 'agent');
    client.emit('modue.display.release', {});
    assert.equal(conn.displayMode, 'ambient');
    assert.equal(conn.agentDisplay, null);
  });

  it('auto-releases after TTL', async () => {
    const { conn, client } = connectedPair();
    client.emit('modue.display.set', { title: 'Flash', ttl: 0.1 }); // 0.1 seconds for test
    assert.equal(conn.displayMode, 'agent');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(conn.displayMode, 'ambient');
  });

  it('stores raw layout on modue.display.raw', () => {
    const { conn, client } = connectedPair();
    const layout = { widget: 'live', rows: [{ height: 48, cols: [{ text: 'Hello', fontSize: 24 }] }] };
    client.emit('modue.display.raw', layout);
    assert.equal(conn.displayMode, 'agent');
    assert.deepEqual(conn.agentDisplay.raw, layout);
  });
});
```

**Step 2: Run test to verify fails**

**Step 3: Implement agent display state in Connection**

In constructor:
```js
this.agentDisplay = null;  // null | { face?, title?, body?, image?, style?, raw?, widget?, ttl? }
this._agentDisplayTimer = null;
```

In `_wireEvents()`:
```js
c.on('modue.display.set', (payload) => {
  if (!payload) return;
  this.agentDisplay = {
    face: payload.face || null,
    title: payload.title || null,
    body: payload.body || null,
    image: payload.image || null,
    style: payload.style || null,
    widget: payload.widget || null,
    raw: null,
  };
  this.displayMode = 'agent';
  this._startAgentDisplayTtl(payload.ttl);
  this._notify();
});

c.on('modue.display.raw', (payload) => {
  if (!payload) return;
  this.agentDisplay = {
    face: null, title: null, body: null, image: null, style: null,
    widget: payload.widget || null,
    raw: payload,
  };
  this.displayMode = 'agent';
  this._startAgentDisplayTtl(payload.ttl);
  this._notify();
});

c.on('modue.display.release', () => {
  this._releaseAgentDisplay();
});
```

Add methods:
```js
_startAgentDisplayTtl(ttl) {
  if (this._agentDisplayTimer) clearTimeout(this._agentDisplayTimer);
  this._agentDisplayTimer = null;
  if (ttl && ttl > 0) {
    this._agentDisplayTimer = setTimeout(() => {
      this._releaseAgentDisplay();
    }, ttl * 1000);
  }
}

_releaseAgentDisplay() {
  if (this._agentDisplayTimer) { clearTimeout(this._agentDisplayTimer); this._agentDisplayTimer = null; }
  this.agentDisplay = null;
  if (this.displayMode === 'agent') {
    this.displayMode = 'ambient';
  }
  this._notify();
}
```

Update `_teardown()`:
```js
_teardown() {
  this.disconnect();
  this._stopIdleCycle();
  this._stopElapsedTimer();
  if (this._agentDisplayTimer) { clearTimeout(this._agentDisplayTimer); this._agentDisplayTimer = null; }
  this._subscribers.clear();
}
```

**Step 4: Run tests to verify passes**

**Step 5: Commit**

```
git commit -m "feat: agent display control — set, raw, release, TTL"
```

---

### Task 16: Render agent display content in widgets

**Files:**
- Modify: `lib/widgets.js` — each widget checks `displayMode === 'agent'` and renders `agentDisplay` content

This is the rendering side. Each widget uses its own size to decide how to present agent content.

**Step 1: Add agent rendering branch to each widget**

In each widget's `bindDisplay` callback, add the agent branch BEFORE the ambient branch:

```js
unsub = bindDisplay(conn, dc, (c, d) => {
  // Priority: approval > agent > streaming > ambient
  if (c.displayMode === 'approval' && c.pendingApproval) {
    // ... existing approval rendering (for approval widget only)
  } else if (c.displayMode === 'agent' && c.agentDisplay) {
    renderAgentContent(c, d, 'status');  // widget-specific target name
  } else if (c.displayMode === 'streaming') {
    // ... existing streaming rendering
  } else {
    // ... ambient rendering from Phase 1
  }
});
```

Add a shared helper at the top of widgets.js:

```js
/**
 * Render agent-controlled content into a widget's display components.
 * Adapts to what components are available in the widget.
 */
function renderAgentContent(c, d, widgetType) {
  const a = c.agentDisplay;
  if (!a) return;

  // Face → icon component (rendered as Material Symbol if available)
  if (a.face && d.icon) {
    d.icon.set(a.face);
  }

  // Title → status component
  if (a.title && d.status) {
    d.status.set(a.title);
  }

  // Body → content component
  if (a.body && d.content) {
    d.content.set(a.body);
  } else if (a.body && d['ap-cmd']) {
    d['ap-cmd'].set(a.body);
  }

  // Footer shows style or clears
  if (d.footer) {
    d.footer.set(a.style ? `[${a.style}]` : '');
  }
  if (d.elapsed) {
    d.elapsed.set('');
  }
}
```

**Step 2: Update each widget's bind callback** — add the `c.displayMode === 'agent'` check to all 6 widgets.

**Step 3: Sync and test** — have a test gateway frame push `modue.display.set` and verify it appears on the display.

**Step 4: Commit**

```
git commit -m "feat: render agent display content across all widgets"
```

---

### Task 17: Add image support to display widgets

**Files:**
- Modify: `lib/widgets.js` — add `addDisplayImage` component to widgets that support it (Stream, Live, Full)

The larger widgets get an image layer that can be shown when the agent pushes an image.

**Step 1: Add image component to Claw Live and Claw Full**

In `registerClawLive`, add a second layer on top for images:

```js
.addLayer((layer) => {
  // ... existing layer (layer 1 - text content)
})
.addLayer((layer) => {
  // Layer 2 — agent image overlay (hidden by default)
  layer
    .setMargin(3, 3, 3, 3)
    .setBorderRadius(4, 4, 4, 4);
  layer.addRow((row) => {
    row.setSize(234, 474);
    row.addDisplayImage('agent-image', (img) =>
      img
        .setSize(234, 474)
        .setImageBase64Data('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=') // 1px transparent
    );
  });
})
```

In the agent rendering branch, when `agentDisplay.image` is set:

```js
if (a.image && d['agent-image']) {
  d['agent-image'].set(a.image);
}
```

When releasing or switching to non-agent mode, reset to transparent pixel.

**Step 2: Same for Claw Full (adjust size to 234x954).**

**Step 3: Sync and test** — push a base64 image via `modue.display.set` and verify it renders.

**Step 4: Commit**

```
git commit -m "feat: image overlay support for Live and Full widgets"
```

---

### Task 18: Add face rendering with Material Symbols

**Files:**
- Modify: `lib/widgets.js` — when `agentDisplay.face` is set, render the icon component using `setIsIcon(true)`

The Claw Status widget's icon component was set up with emoji. To support Material Symbols, we need to re-register the icon text component with `setIsIcon(true)` in a separate configuration, OR dynamically detect and switch.

**Approach:** Since `setIsIcon` is set at registration time and can't be toggled at runtime, we add a second text component `'face-icon'` with `setIsIcon(true)` alongside the existing emoji `'icon'` component. When agent sets a face, we populate `'face-icon'` and clear `'icon'`; otherwise we use `'icon'` for the lobster.

**Step 1: Add face-icon component to Claw Status**

In `registerClawStatus`, in the icon row, add a second text element:

```js
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
      .setMargin(8, 0, 0, 0)
      .setIsIcon(true)
      .setSize(0, 0) // hidden by default
  );
});
```

In the agent rendering path:

```js
if (a.face) {
  d['icon']?.set('');          // hide emoji
  d['face-icon']?.set(a.face); // show Material Symbol
  // TODO: figure out how to toggle visibility — may need to use size or empty text
} else {
  d['icon']?.set('\u{1F99E}'); // show lobster
  d['face-icon']?.set('');     // hide icon
}
```

> **Note:** This may need experimentation — the SDK may not support dynamically toggling element visibility. If setting text to '' effectively hides it, this works. If not, we may need to use the overlay layer approach (face-icon on a second layer that covers the emoji).

**Step 2: Apply same pattern to Stream, Live, Full widgets.**

**Step 3: Sync and test** — push `modue.display.set` with `face: 'sentiment_satisfied'`, verify Material Symbol icon appears.

**Step 4: Commit**

```
git commit -m "feat: Material Symbol face rendering on agent display"
```

---

### Task 19: Add touch event forwarding to gateway

**Files:**
- Modify: `lib/widgets.js` — register touch handlers on content areas
- Modify: `lib/connection.js` — add `sendTouch()` method

**Step 1: Add sendTouch to Connection**

```js
sendTouch(widget, gesture) {
  if (!this._client) return;
  this._client.rpc('modue.display.touched', { widget, gesture }).catch(() => {});
}
```

**Step 2: Add touch handlers to display content areas**

On the content rows of Claw Live and Claw Full, register swipe detection:

```js
// In registerClawLive, on the content row:
layer.addRow((row) => {
  row.setSize(234, 390).setBackgroundColor(COLORS.bg);
  row.addDisplayText('content', (t) =>
    t.setText('Waiting for activity...')
      .setColor(COLORS.text)
      .setFontSize(28)
      .setMargin(6, 5, 4, 5)
      .setTextWrap('wrap')
  );

  let touchStart = null;
  row.registerOnTouchStartHandler(() => { touchStart = Date.now(); });
  row.registerOnTouchEndHandler(() => {
    const conn = Connection.getInstance(storage, log);
    if (touchStart && Date.now() - touchStart < 300) {
      conn.sendTouch('live', 'tap');
    }
    touchStart = null;
  });
  row.registerOnTouchMoveHandler((value) => {
    const conn = Connection.getInstance(storage, log);
    if (Math.abs(value.deltaY) > 30) {
      conn.sendTouch('live', value.deltaY < 0 ? 'swipe-up' : 'swipe-down');
    } else if (Math.abs(value.deltaX) > 30) {
      conn.sendTouch('live', value.deltaX > 0 ? 'swipe-right' : 'swipe-left');
    }
  });
});
```

> **Note:** `registerOnTouchStartHandler` is on DisplayElementSDK (rows/columns), NOT on the display text. Need to verify this works at the row level. If touch handlers must be on the display itself, register them on the display registration chain instead.

**Step 3: Sync and test** — tap/swipe the display, check gateway receives events.

**Step 4: Commit**

```
git commit -m "feat: forward touch events to gateway"
```

---

### Task 20: Add `modue.capabilities` response

**Files:**
- Modify: `lib/connection.js` — handle `modue.capabilities` request from gateway

When the gateway asks what hardware is available, the plugin responds with the full capability map.

**Step 1: Add capabilities handler in Connection**

In `_wireEvents()`:

```js
c.on('modue.capabilities', () => {
  // This would be an RPC response — need to check if the gateway
  // requests this or if we push it proactively on connect.
  // For now, send it as part of the connection handshake.
});
```

Actually, capabilities should be pushed on connect. In the `connection` handler, after connected:

```js
if (info.connected) {
  // ... existing code ...
  // Announce hardware capabilities
  this._client.rpc('modue.capabilities', {
    displays: [
      { name: 'status', rows: 1, cols: 1, widthPx: 120, heightPx: 120 },
      { name: 'stream', rows: 2, cols: 2, widthPx: 240, heightPx: 240 },
      { name: 'live', rows: 4, cols: 2, widthPx: 240, heightPx: 480 },
      { name: 'full', rows: 8, cols: 2, widthPx: 240, heightPx: 960 },
      { name: 'channels', rows: 2, cols: 1, widthPx: 120, heightPx: 240 },
      { name: 'approval', rows: 2, cols: 1, widthPx: 120, heightPx: 240 },
    ],
    leds: 8,
    keys: ['left', 'center', 'right'],
    knob: true,
    slider: true,
  }).catch(() => {});
}
```

**Step 2: Commit**

```
git commit -m "feat: announce modue capabilities on connect"
```

---

### Task 21: OpenClaw Gateway — add modue.* schema and handlers

**Files (in /Users/dan/.openclaw/openclaw/):**
- Create: `src/gateway/protocol/schema/modue.ts`
- Modify: `src/gateway/protocol/schema/protocol-schemas.ts` — import modue schemas
- Create: `src/gateway/server-methods/modue.ts`
- Modify: `src/gateway/server-methods.ts` — import and merge modue handlers

This task adds the gateway-side support so agents can send `modue.*` frames. The gateway acts as a relay — it receives `modue.*` RPCs from agents and broadcasts them as events to the connected Modue plugin client.

**Step 1: Create schema file**

Create `src/gateway/protocol/schema/modue.ts`:

```ts
import { Type, type Static } from "@sinclair/typebox";

// --- Display control ---

export const ModueDisplaySetParamsSchema = Type.Object({
  widget: Type.Optional(Type.String()),
  face: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  image: Type.Optional(Type.String()),
  style: Type.Optional(Type.String()),
  ttl: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

export type ModueDisplaySetParams = Static<typeof ModueDisplaySetParamsSchema>;

export const ModueDisplayRawParamsSchema = Type.Object({
  widget: Type.Optional(Type.String()),
  rows: Type.Array(Type.Object({
    height: Type.Number(),
    bg: Type.Optional(Type.String()),
    cols: Type.Array(Type.Object({
      text: Type.Optional(Type.String()),
      fontSize: Type.Optional(Type.Number()),
      color: Type.Optional(Type.String()),
      align: Type.Optional(Type.String()),
      image: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String()),
    })),
  })),
  ttl: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

export type ModueDisplayRawParams = Static<typeof ModueDisplayRawParamsSchema>;

export const ModueDisplayReleaseParamsSchema = Type.Object({
  widget: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const ModueDisplayAmbientParamsSchema = Type.Object({}, { additionalProperties: false });

// --- Slider ---

export const ModueSliderSetParamsSchema = Type.Object({
  value: Type.Number({ minimum: 0, maximum: 100 }),
}, { additionalProperties: false });

export type ModueSliderSetParams = Static<typeof ModueSliderSetParamsSchema>;

// --- LEDs ---

export const ModueLedSetParamsSchema = Type.Object({
  colors: Type.Array(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });

export const ModueLedPatternParamsSchema = Type.Object({
  pattern: Type.Union([
    Type.Literal('pulse'),
    Type.Literal('chase'),
    Type.Literal('breathe'),
    Type.Literal('solid'),
    Type.Literal('flash'),
  ]),
  color: Type.String(),
  speed: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
}, { additionalProperties: false });

export const ModueLedReleaseParamsSchema = Type.Object({}, { additionalProperties: false });

// --- Keys ---

export const ModueKeyLabelsParamsSchema = Type.Object({
  left: Type.Optional(Type.String()),
  center: Type.Optional(Type.String()),
  right: Type.Optional(Type.String()),
}, { additionalProperties: false });

// --- Capabilities (response only, no params needed) ---

export const ModueCapabilitiesParamsSchema = Type.Object({}, { additionalProperties: false });
```

**Step 2: Import in protocol-schemas.ts**

Add import and merge into the ProtocolSchemas export:

```ts
import {
  ModueDisplaySetParamsSchema,
  ModueDisplayRawParamsSchema,
  ModueDisplayReleaseParamsSchema,
  ModueSliderSetParamsSchema,
  ModueLedSetParamsSchema,
  ModueLedPatternParamsSchema,
  ModueLedReleaseParamsSchema,
  ModueKeyLabelsParamsSchema,
  ModueCapabilitiesParamsSchema,
} from "./modue.js";
```

Add to the schemas object:
```ts
"modue.display.set": ModueDisplaySetParamsSchema,
"modue.display.raw": ModueDisplayRawParamsSchema,
"modue.display.release": ModueDisplayReleaseParamsSchema,
"modue.slider.set": ModueSliderSetParamsSchema,
"modue.leds.set": ModueLedSetParamsSchema,
"modue.leds.pattern": ModueLedPatternParamsSchema,
"modue.leds.release": ModueLedReleaseParamsSchema,
"modue.key.labels": ModueKeyLabelsParamsSchema,
"modue.capabilities": ModueCapabilitiesParamsSchema,
```

**Step 3: Create handler file**

Create `src/gateway/server-methods/modue.ts`:

```ts
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Modue hardware control handlers.
 * These relay commands from agents to connected Modue plugin clients.
 * The Modue plugin listens for these events on the WebSocket connection.
 */
export const modueHandlers: GatewayRequestHandlers = {
  "modue.display.set": async ({ params, respond, context }) => {
    context.broadcast("modue.display.set", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.display.raw": async ({ params, respond, context }) => {
    context.broadcast("modue.display.raw", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.display.release": async ({ params, respond, context }) => {
    context.broadcast("modue.display.release", params ?? {}, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.slider.set": async ({ params, respond, context }) => {
    context.broadcast("modue.slider.set", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.leds.set": async ({ params, respond, context }) => {
    context.broadcast("modue.leds.set", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.leds.pattern": async ({ params, respond, context }) => {
    context.broadcast("modue.leds.pattern", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.leds.release": async ({ params, respond, context }) => {
    context.broadcast("modue.leds.release", params ?? {}, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.key.labels": async ({ params, respond, context }) => {
    context.broadcast("modue.key.labels", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  // Inbound events from Modue plugin (hardware → agents)
  // These are received as RPCs from the plugin and broadcast to agent clients

  "modue.slider.changed": async ({ params, respond, context }) => {
    context.broadcast("modue.slider.changed", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.knob.changed": async ({ params, respond, context }) => {
    context.broadcast("modue.knob.changed", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.key.pressed": async ({ params, respond, context }) => {
    context.broadcast("modue.key.pressed", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.display.touched": async ({ params, respond, context }) => {
    context.broadcast("modue.display.touched", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },

  "modue.capabilities": async ({ params, respond, context }) => {
    // Relay capabilities announcement from plugin
    context.broadcast("modue.capabilities", params, { dropIfSlow: true });
    respond(true, { relayed: true }, undefined);
  },
};
```

**Step 4: Register in server-methods.ts**

```ts
import { modueHandlers } from "./server-methods/modue.js";

// In the coreGatewayHandlers spread:
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...existingHandlers,
  ...modueHandlers,
};
```

**Step 5: Build and test**

```
cd /Users/dan/.openclaw/openclaw && npm run build
```

Verify no type errors.

**Step 6: Commit** (in the openclaw repo)

```
cd /Users/dan/.openclaw/openclaw && git commit -m "feat: add modue.* gateway handlers for hardware control"
```

---

### Task 22: End-to-end integration test

**Step 1:** Start OpenClaw gateway with the new modue.* handlers.

**Step 2:** Start Modue with the updated plugin.

**Step 3:** Verify ambient mode:
- Widgets show system stats (CPU/RAM/disk/network from `useSystemMonitorResources`)
- Last activity shows after an agent run completes
- Connection health shows uptime and reconnect count

**Step 4:** Verify physical controls:
- Move slider → gateway receives `modue.slider.changed`
- Turn knob → gateway receives `modue.knob.changed`
- Press keys → gateway receives `modue.key.pressed`

**Step 5:** Verify agent display control (from a test script or agent):
```js
// Send via WebSocket to gateway:
{ type: 'req', id: '1', method: 'modue.display.set', params: { face: 'sentiment_satisfied', title: 'Hello!', body: 'I am OpenClaw' } }
{ type: 'req', id: '2', method: 'modue.slider.set', params: { value: 75 } }
{ type: 'req', id: '3', method: 'modue.leds.pattern', params: { pattern: 'breathe', color: '#4488ff', speed: 3 } }
{ type: 'req', id: '4', method: 'modue.key.labels', params: { left: 'Yes', center: 'Menu', right: 'No' } }
// Then release:
{ type: 'req', id: '5', method: 'modue.display.release', params: {} }
{ type: 'req', id: '6', method: 'modue.leds.release', params: {} }
```

**Step 6:** Verify priority stack:
- Agent display overrides ambient
- Approval overrides agent display
- Release returns to ambient

**Step 7: Commit**

```
git commit -m "chore: end-to-end verification complete"
```

---

## Verification Checklist

### Phase 1 — Ambient Mode
- [ ] System stats display on all widgets when idle
- [ ] Stats update in real-time (useSystemMonitorResources fires)
- [ ] Last activity captured on agent lifecycle end
- [ ] Last activity displayed with channel/sender/time
- [ ] Connection health shows uptime and reconnect count
- [ ] Widgets switch from ambient → streaming when agent starts
- [ ] Widgets switch from streaming → ambient when agent ends
- [ ] Approval widget shows mini stats when no approval pending

### Phase 2 — Physical Controls
- [ ] Slider registered and visible in Modue
- [ ] Slider moved by agent via `modue.slider.set`
- [ ] Physical slider movement sends `modue.slider.changed` to gateway
- [ ] Knob turns send `modue.knob.changed` to gateway
- [ ] Key presses send `modue.key.pressed` to gateway
- [ ] Key presses still handle approvals when pending
- [ ] Dynamic key labels received from `modue.key.labels`
- [ ] Key labels shown in widget footers
- [ ] LED override via `modue.leds.set` (direct colors)
- [ ] LED patterns via `modue.leds.pattern` (pulse, chase, breathe, solid, flash)
- [ ] LED release returns to status-based colors

### Phase 3 — Agent Display Control
- [ ] `modue.display.set` switches to agent mode
- [ ] Title, body render in widget content areas
- [ ] Face renders as Material Symbol icon
- [ ] Image renders as overlay on Live/Full widgets
- [ ] TTL auto-releases back to ambient
- [ ] `modue.display.release` returns to ambient
- [ ] `modue.display.raw` renders full custom layout
- [ ] Touch events forwarded to gateway
- [ ] Capabilities announced on connect
- [ ] Priority: approval > agent > streaming > ambient
- [ ] Gateway schemas compile without errors
- [ ] Gateway handlers relay all modue.* frames
