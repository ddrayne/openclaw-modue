# @modue/openclaw

A [Modue](https://www.modue.com) control surface plugin for
[OpenClaw](https://openclaw.ai) — turn the Modue's display, slider,
keys, knob, and LED cluster into a physical dashboard for your AI
assistant.

Built for headless setups (Mac Mini behind a TV, no monitor) where you
want at-a-glance status and physical approve / deny buttons for the
agent without context-switching to a terminal.

## How the pieces fit

```
   ┌─────────────────────┐                    ┌─────────────────────┐
   │   Modue device      │                    │   OpenClaw agent    │
   │ (display, LEDs,     │                    │ (LLM, channels,     │
   │  slider, keys)      │                    │  approvals, etc.)   │
   └──────────┬──────────┘                    └──────────┬──────────┘
              │                                          │
              ▼                                          │
   ┌─────────────────────┐                               │
   │  this plugin        │                               │
   │  (@modue/openclaw)  │                               │
   │  inside Modue app   │                               │
   └──────────┬──────────┘                               │
              │ WebSocket (auth + device pairing)        │
              ▼                                          ▼
   ┌────────────────────────────────────────────────────────────┐
   │              OpenClaw gateway (host)                       │
   │   relays modue.* events via the openclaw-modue-bridge      │
   │   plugin (https://github.com/ddrayne/openclaw-modue-bridge)│
   └────────────────────────────────────────────────────────────┘
```

You need **both** sides — this Modue-platform plugin, and the
openclaw-side
[`@ddrayne/openclaw-modue-bridge`](https://github.com/ddrayne/openclaw-modue-bridge)
plugin that registers the `modue.*` gateway methods.

## What you get on the device

### Display widgets (7 total)

| Widget        | Size  | Shows                                                               |
| ------------- | ----- | ------------------------------------------------------------------- |
| `Claw Status` | 1×1   | Compact status pill — emoji + state + elapsed timer                 |
| `Claw Stream` | 2×2   | Mid-size live agent text + status line                              |
| `Claw Live`   | 4×2   | Main streaming view — full agent reply, source, controls            |
| `Claw Full`   | 8×2   | Immersive reading view — large type, optimized for far viewing      |
| `Channels`    | 2×1   | Per-channel connection health (WhatsApp, Telegram, Slack, …)        |
| `Approval`    | 2×1   | Pending exec-approval card with risk level + key hint               |
| `Claw Info`   | 2×2   | Context-aware: scroll position, model name, today's cost, approval  |

Drag the widgets you want into your Modue layout in the Modue app.

### Physical controls

- **Left key**: approve pending exec / abort current generation / wake the
  assistant (depending on context).
- **Right key**: deny pending exec / fetch a usage-cost summary onto the
  display (depending on context).
- **Center key**: fetch + render the current channel-connection status.
- **Slider** (motorized fader): scroll back through the streaming reply
  text. Auto-resets to live after 5s of no movement. Agents can also push
  a target position via the `modue_slider` tool.
- **Knob**: reserved.
- **LED cluster**: ambient status — green=idle, purple=thinking,
  blue=replying, orange=working, red=error, gray=offline. Flashing amber
  during a pending approval. Agents can override patterns through the
  `modue_leds` tool.

## Setup

### Prerequisites

- A [Modue](https://www.modue.com) device + the Modue desktop app (macOS).
- An [OpenClaw](https://openclaw.ai) install with the gateway running
  locally — `openclaw gateway status` should report `Runtime: running`.
- The companion openclaw-side plugin
  [`@ddrayne/openclaw-modue-bridge`](https://github.com/ddrayne/openclaw-modue-bridge)
  installed (`openclaw plugins install @ddrayne/openclaw-modue-bridge`).

### Install (Modue side)

```sh
git clone https://github.com/ddrayne/openclaw-modue.git
ln -s "$PWD/openclaw-modue" "$HOME/Library/Application Support/modue/plugins/openclaw-modue"
```

Then in the Modue app: relaunch (or `Cmd+Shift+R` to hot-reload). The
plugin appears under **Plugins → OpenClaw**.

### Configure

1. Pull your gateway auth token from OpenClaw:

   ```sh
   python3 -c "import json,os; print(json.load(open(f'{os.path.expanduser(\"~\")}/.openclaw/openclaw.json'))['gateway']['auth']['token'])"
   ```

2. In the Modue plugin settings, set:
   - **Gateway URL**: `ws://127.0.0.1:18789` (default — leave alone unless
     you've moved the gateway).
   - **Gateway Token**: the value you pulled in step 1.

3. Click **Connect**, or `Cmd+Shift+R` to reload.

### Verify

Tail the plugin log:

```sh
tail -f "$HOME/Library/Application Support/modue/pluginLogs/openclaw.log"
```

You should see, in order:

```
Connecting to OpenClaw at ws://127.0.0.1:18789
Challenge received, building device identity
Device identity loaded: …
Device token saved (pairing approved)        ← first time only
Connected to OpenClaw gateway
modue bridge primed
```

Drag a widget (e.g. `Claw Live`) onto the device. Send any message
through OpenClaw and the agent's reply should stream onto the display
in real time.

## Repo layout

```
openclaw-modue/
├── index.js           # Entry — registers config, widgets, slider, keys, LEDs
├── lib/
│   ├── connection.js  # Singleton — agent state, subscriber pattern, lifecycle
│   ├── widgets.js     # 7 display widgets (Claw Status / Stream / Live / …)
│   ├── ws-client.js   # Minimal WS client (Node http + crypto, no npm deps)
│   └── renderer.js    # Display formatting helpers (colors, truncate, time)
├── test/
│   ├── connection.test.js  # 153 cases, exhaustive Connection coverage
│   └── ws-client.test.js   # 4 cases for the disconnect-drain behavior
├── icon.png / icon.svg
├── package.json
├── sync.sh            # Dev: rsync source -> Modue install dir
└── README.md
```

Zero npm dependencies. The plugin uses Node 22+ built-ins only (`http`,
`crypto`, `events`).

## Development

```sh
npm test                           # 157 tests, ~250ms

# Push local source into the Modue install dir without committing:
bash sync.sh
# Then Cmd+Shift+R in Modue.
```

`"devMode": true` is set in `package.json` so the Modue app picks up
hot-reloads.

## Troubleshooting

**`gateway token mismatch`**

Modue's stored `Gateway Token` doesn't match `gateway.auth.token` in
`~/.openclaw/openclaw.json`. The token rotates if you reinstall or
upgrade OpenClaw. Re-extract (see Configure step 1) and paste the new
value.

**`bridge ping failed: …`**

The openclaw-side
[`@ddrayne/openclaw-modue-bridge`](https://github.com/ddrayne/openclaw-modue-bridge)
plugin isn't loaded. Install it and restart the gateway:

```sh
openclaw plugins install @ddrayne/openclaw-modue-bridge
openclaw gateway stop && openclaw gateway start
```

**Modue plugin process RSS climbing during agent activity**

You're on an old version. Update to the latest commit (the per-notify
`channels.status` fan-out used to OOM the Modue platform under sustained
streaming). `Cmd+Shift+R` after pulling.

**Plugin log shows multiple parallel "Attempting reconnect…"**

The Connect button or widget initializers fired more than once. Harmless
once auth succeeds, but worth `Cmd+Shift+R` to get a clean single
connection.

## Compatibility

- Node **22+** required (uses built-in WebSocket framing patterns).
- macOS only (`os: "darwin"` in package.json — Modue itself is macOS only).
- OpenClaw protocol v3 (PROTOCOL_VERSION constant in `lib/ws-client.js`).

## License

ISC.
