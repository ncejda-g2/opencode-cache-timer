# Changelog

All notable changes to `cache-timer` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-26

### Added
- **Clickable "Refresh Cache" button** rendered above the timer in
  `session_prompt_right`. Sends a tiny `say 'refresh'` prompt to the current
  session on mouse-down, giving users a manual one-click way to keep the
  prompt cache hot without typing anything. Hover changes the border and
  text color to green; in-flight requests dim the button and swap the label
  to `Sending...` until the prompt resolves. A `refreshInFlight` signal
  debounces rapid clicks so a single click can't queue multiple prompts.
  Mouse support depends on the host terminal: iTerm2, kitty, Alacritty,
  WezTerm, and modern Terminal.app all forward `onMouseDown` correctly.

## [1.0.0] - 2026-05-26

Initial public release.

### Added
- **Visual cache countdown** rendered in `session_prompt_right`. Shows time
  remaining until the prompt cache goes cold, with `HOT`, near-expiry warning,
  and `COLD` states. Per-model duration based on substring-matched provider
  family.
- **Opt-in pre-emptive auto-summary.** When `enableAutoPrompt: true` is set in
  the sidecar config, the plugin fires a tiny "Summarize our progress and next
  steps. Be brief." prompt 15 seconds before the cache expires. The summary
  reads from the hot cache (cheap), giving you an artifact to paste into a
  fresh session and skip the cold-write tax of resuming the bloated original.
  Off by default — the plugin never spends tokens without explicit consent.
- **Sidecar config** at `~/.config/opencode/cache-timer.json` (global) and
  `./.opencode/cache-timer.json` (project). Project values win per-field over
  global. Supports `enableAutoPrompt`, `durations` (per-family seconds), and
  `defaultDuration`.
- **Family-key duration map** with substring matching. A single `"claude": 300`
  entry covers `claude-opus-4-7`, `claude-haiku-4-5`, `claude-3-5-sonnet`, etc.
- **Race-safe auto-prompt detection.** The plugin tracks pending auto-prompts
  via a synchronous user-message-count snapshot
  (`pendingAutoPromptUserCount: Map<sessionId, number>`) taken at trigger
  time, then ledgers the next user message whose index exceeds the snapshot
  as automated. The ledgering branch runs on every tick — including busy
  ticks — so the auto-prompt cannot mistakenly re-arm itself and re-fire.
- **File-based debug log** at `/tmp/cache-timer-debug.log` capturing `tui()`
  init and config-resolution events. Per-tick writes intentionally omitted
  to keep the log near-free.

### Notes
- Configuration is intentionally a sidecar JSON file rather than inline in
  `opencode.json`. Released opencode (v1.15.x) does not forward the second
  tuple element of `["file://path", { ...options }]` plugin entries to TUI
  plugins' `tui()` entrypoint, and `opencode.json` itself rejects unknown
  top-level keys. An empirical survey of nine ecosystem plugins
  (`opencode-dcp`, `opencode-vibeguard`, `opencode-sentry-monitor`,
  `opencode-notificator`, `opencode-wakatime`, `opencode-morph-fast-apply`,
  `opencode-helicone-session`, `opencode-md-table-formatter`, and the
  official plugin template) found zero using the tuple-options mechanism;
  the four config-heavy plugins all use sidecar JSON files.
