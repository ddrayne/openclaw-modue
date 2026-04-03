# openclaw-modue

Modue hardware control surface for [OpenClaw](https://github.com/nicepkg/openclaw) — turn your Modue device into a physical dashboard for your AI assistant.

Built for headless setups (e.g. Mac Mini without a screen) where you want at-a-glance status and physical controls for OpenClaw.

## What it does

Connects to OpenClaw's WebSocket gateway and maps its state onto the Modue's display, keys, knobs, and LEDs.

### Pages

| Page | Display | Controls |
|------|---------|----------|
| **Agent Live** | Streaming AI activity — thinking, text, tool calls | Approve/deny exec requests, scroll buffer |
| **Channels** | Per-channel connection health (WhatsApp, Telegram, Slack, etc.) | Scroll, toggle channels |
| **Sessions** | Conversation browser with detail overlay (model, tokens, cost) | Browse, select, watch live |
| **Commands** | Configurable quick-action buttons | Trigger cron jobs, send messages, health checks |

### Physical controls

- **Keys**: Page navigation + context-sensitive actions (approve/deny, select, fire commands)
- **Knob**: Scroll/navigate on each page
- **LEDs**: Green = idle, pulsing blue = agent running, red = error, flashing amber = approval pending

## Installation

1. Copy this folder to the Modue plugins directory:
   ```
   ~/Library/Application Support/modue/plugins/openclaw-modue
   ```
   Or symlink it for development:
   ```
   ln -s /path/to/openclaw-modue ~/Library/Application\ Support/modue/plugins/openclaw-modue
   ```

2. Restart the Modue app (or Cmd+Shift+R to hot-reload)

3. In the Modue plugin settings, configure:
   - **Gateway URL**: `ws://127.0.0.1:18789` (default)
   - **Gateway Token**: your `OPENCLAW_GATEWAY_TOKEN` value

4. Drag the OpenClaw widgets onto your device layout

## Configuration

Command slots (1–3) are configurable in the Modue settings panel:

- **Label**: display text for the button
- **Action**: Trigger Cron Job, Send Agent Message, Health Check, or Tail Logs
- **Parameter**: cron job ID or message text

## Development

Zero npm dependencies — uses the Node.js 22+ built-in WebSocket API.

```
openclaw-modue/
├── index.js              # Entry point — widget registration, config, page wiring
├── lib/
│   ├── ws-client.js      # OpenClaw WebSocket client (connect, auth, RPC, events)
│   ├── state.js          # Centralized state store with page system
│   ├── renderer.js       # Shared display utilities (colors, truncate, timeAgo)
│   └── pages/
│       ├── agent-live.js # Live agent activity + exec approval controls
│       ├── channels.js   # Channel health dashboard
│       ├── sessions.js   # Session browser + detail overlay
│       └── commands.js   # Configurable quick-action buttons
├── icon.png
├── icon.svg
└── package.json
```

Set `"devMode": true` in package.json (already set) to enable hot-reload during development.

## Requirements

- [Modue](https://www.modue.com/) device + app (macOS)
- [OpenClaw](https://github.com/nicepkg/openclaw) gateway running locally
- `OPENCLAW_GATEWAY_TOKEN` configured

## License

ISC
