# Changelog

All notable changes to `opencode-cache-timer` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once published.

## [Unreleased]

### Fixed
- **Infinite auto-summary loop.** When the cache-expiry auto-prompt fired, the
  plugin previously relied on a transient `isTriggeringAutoSummary` flag to
  recognize the auto-prompt's own user message as automated. That flag flipped
  back to `false` as soon as the `api.client.session.prompt` API call resolved
  — typically before the session left the `busy` state — and the per-tick
  user-message ledgering branch was suppressed by an early-return while busy.
  The result: when busy cleared, the ledger had never recorded the auto-prompt
  id, the next tick interpreted it as a human prompt, re-armed the trigger,
  and the summary fired again on the next 15s-remaining boundary. Forever.

  Replaced the flag with a synchronous snapshot of the user-message count at
  trigger time (`pendingAutoPromptUserCount: Map<sessionId, number>`). The
  next user message whose index exceeds that snapshot is, by construction,
  the auto-prompt and is ledgered as such. The ledgering branch now also
  runs on every tick — including busy ticks — so the race window is closed.

### Changed
- **Config mechanism: sidecar JSON file instead of inline `opencode.json` tuple.**
  Released opencode (v1.15.x) does not forward the second tuple element of
  `["file://path", { ...options }]` plugin entries to TUI plugins' `tui()`
  entrypoint, despite the schema accepting it. An empirical survey of nine
  active ecosystem plugins (`opencode-dcp`, `opencode-vibeguard`,
  `opencode-sentry-monitor`, `opencode-notificator`, `opencode-wakatime`,
  `opencode-morph-fast-apply`, `opencode-helicone-session`,
  `opencode-md-table-formatter`, and the official plugin template) found
  **zero** plugins using the `options` argument. The four config-heavy
  plugins all use sidecar JSON files; the rest use env vars or no config.

  Cache-timer now reads `~/.config/opencode/cache-timer.json` (global) and
  `./.opencode/cache-timer.json` (project), with project values winning
  per-field. The plugin function ignores any `options` argument.

- **Family-key matcher simplified.** Default duration map is now keyed by
  provider family only (`claude`, `gemini`, `gpt`) instead of the previous
  per-variant entries (`claude-3-5`, `claude-3-7`, `claude-opus`, ...).
  `getCacheDuration` uses `String.prototype.includes` substring matching, so
  a single `claude` entry covers `claude-opus-4-7`, `claude-haiku-4-5`,
  `claude-3-5-sonnet`, etc.

### Added
- File-based debug log at `/tmp/cache-timer-debug.log` capturing `tui()` init
  and config-resolution events. Useful for diagnosing future config issues
  without relying on toast stacking. Per-tick writes were intentionally
  omitted to keep the log near-free.

### Migration (if you were running the pre-1.0.0 dev build)
If you previously configured the plugin via the `opencode.json` tuple form:

```jsonc
// OLD (does not work in released opencode)
{
  "plugin": [
    ["file:///path/to/cache-timer", { "enableAutoPrompt": true, "durations": { ... } }]
  ]
}
```

move the second element into `~/.config/opencode/cache-timer.json`:

```jsonc
// NEW
{
  "enableAutoPrompt": true,
  "durations": { "claude": 300, "gemini": 300, "gpt": 300 }
}
```

and reduce the `opencode.json` plugin entry to a bare path (or remove it
entirely if the plugin lives in `~/.config/opencode/plugins/`, in which case
opencode auto-loads it from there).

## [1.0.0] - Unreleased

Initial development build. Not yet published.

### Added
- Visual cache countdown in `session_prompt_right`.
- Opt-in pre-emptive auto-summary 15 seconds before cache expiry.
