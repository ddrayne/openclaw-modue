# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- LICENSE file (ISC).
- `.editorconfig` for cross-editor consistency.
- `test/ws-client.test.js` covering the disconnect-drain behavior.

### Fixed
- **Memory leak under sustained agent streaming**
  (`lib/widgets.js:registerChannels`): the Channels widget previously
  refetched `channels.status` from the gateway on every `_notify()`, which
  fires once per agent stream event (30-80 Hz during LLM streaming). Each
  call queued a 15s-timeout entry in ws-client's `pending` Map; under
  sustained load this grew unbounded and OOM'd the Modue platform host.
  Now refreshes on a 10s interval plus an immediate fetch when
  connectivity flips false→true, and dedupes overlapping in-flight calls.
- **Reconnect-cycle leak**
  (`lib/ws-client.js:disconnect`): in-flight RPCs were left in `pending`
  with their 15s `setTimeout` still alive, pinning the discarded client
  object until each one fired. Now drains every pending RPC at disconnect
  time — callers settle synchronously, the timer queue empties, and the
  discarded client becomes immediately collectable.

### Documentation
- README rewritten to match the actual current architecture: 7 display
  widgets (Claw Status / Stream / Live / Full / Channels / Approval /
  Claw Info) instead of the legacy "Pages" abstraction. Updated upstream
  OpenClaw URL. Added architecture diagram, prerequisites, end-to-end
  verification recipe, and troubleshooting section.

### Tests
- Refreshed nine pre-existing test failures in `test/connection.test.js`
  that were asserting against stale color and length constants from a
  prior refactor. Tests now read live `STATUS_COLORS`, `APPROVAL_COLOR`,
  and `MAX_TEXT_LENGTH` from the connection module so they cannot rot
  the same way again.
- Suite goes from 9 failures to 0 (157 / 157 pass).

## [0.8.0] - 2026-04-05

### Added
- Multi-widget redesign — 7 display widgets sized for different layouts
  (Claw Status 1×1, Claw Stream 2×2, Claw Live 4×2, Claw Full 8×2,
  Channels 2×1, Approval 2×1, Claw Info 2×2).
- Device-identity pairing via Ed25519 keypair stored in plugin storage.
- `modue.bridge.ping` priming on every (re)connect to capture the gateway
  broadcast function for agent tools.

## Earlier

See git history.
