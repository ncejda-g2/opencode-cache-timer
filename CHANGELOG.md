# Changelog

All notable changes to `cache-timer` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-05-28

### Added
- **Live cache countdown during busy turns.** Previously the countdown froze to
  a static `Cache: HOT (Busy)` whenever opencode was processing a turn. The
  prompt-cache TTL clock keeps ticking during a long-running local tool call
  (e.g. a `bash sleep`/`watch`), so freezing hid a real countdown — and the
  cache could silently expire mid-turn with the UI still claiming HOT. The
  timer now stays live while busy: `Cache: HOT (MM:SS) Busy`, going yellow
  under one minute, exactly like the idle countdown.
- **`busy-cold` state + Interrupt & fork.** When the cache expires while a turn
  is still running, the timer now tells the truth (`Cache: COLD (BUSY)`) and
  surfaces a single blue **`✨ Interrupt & fork`** button. Clicking it aborts
  the running turn (`session.abort`) and forks a fresh chat seeded from the
  interrupted output — instead of resuming against a cold cache and paying the
  full cold-start tax. Doing nothing is still a valid choice; the button is an
  option, not a forced action.
- The pending-question cold toast now also fires in the `busy-cold` state and
  points the returning user at `✨ Interrupt & fork`.

### Changed
- **Cache state is the source of truth.** opencode's local "busy" execution
  status no longer masks the cache reality. If the provider cache is cold, the
  user sees COLD regardless of whether a turn is running.
- **Busy anchor selection.** While busy, the remaining time is computed from
  `max(step-finish arrival, newest ASSISTANT message timestamp)`. Using the
  freshest of the two is robust to both stale directions: a new turn's
  assistant timestamp wins over a stale step-finish at turn start, and a
  mid-turn step-finish wins over an older assistant timestamp during a long
  turn.

### Fixed
- **Queued user messages no longer reset the timer.** A user message typed and
  submitted while the session is still busy is created locally but never sent
  to the provider, so it does not refresh the cache. The busy anchor now
  considers **assistant** messages only, so a queued user message no longer
  falsely jumps the countdown back to full.

### Notes
- Phase-2 step-finish instrumentation (the `/tmp/cache-timer-debug.log` tick
  log and dual remaining-time anchors) is intentionally retained for this
  release; the anchors provably diverge in multi-turn use, so the debug trail
  is still earning its keep. It will be removed in a follow-up.

## [1.1.2] - 2026-05-28

### Added
- **Question-pending toast notifications.** When opencode's Question tool
  opens a modal, the session pauses waiting on the user — if the user tabs
  away or walks off and comes back N minutes later, they answer the question
  and immediately pay the cold-cache tax without ever seeing the COLD UI
  indicator behind the modal. The plugin now fires up to two toasts while a
  question is pending:
  - A **yellow "Cache nearly cold" warning** (1-min duration) when the cache
    enters the WARNING state (<1 min remaining).
  - A **blue "Cache cold" info toast** (5-min duration) when the cache enters
    the COLD state.

  Each toast fires at most once per pending-question episode; both dedupes
  re-arm automatically when the question resolves so subsequent queued
  questions get fresh notifications. Toasts only fire while a question is
  pending — during normal interactive use the existing `session_prompt_right`
  countdown is the single source of truth (no redundant noise).

## [1.1.1] - 2026-05-28

### Fixed
- **"New chat" spinner spinning forever when the new session's first reply
  uses an interactive tool.** `handleNewChatClick` previously `await`ed
  `session.prompt` before navigating, but `session.prompt` only resolves when
  the assistant's turn completes. If the LLM invoked the Question tool (or
  any other tool that pauses mid-turn for user input) the promise hung
  indefinitely, so `route.navigate` never fired and `newChatInFlight` /
  `stopSpinner` never cleared — leaving the user stranded on the source
  session with a perpetually animating "Starting..." button. Fix: navigate
  to the new session **first**, then dispatch the seed prompt as
  fire-and-forget with an error toast on rejection. The in-flight window now
  only spans the (sub-second) `session.create` call, making the UX
  predictable regardless of what the assistant does in the new session.

## [1.1.0] - 2026-05-26

### Added
- **Clickable "↻ Refresh" button** in `session_prompt_right`. Sends a tiny
  `say 'refresh'` prompt to the current session on click, giving users a
  manual one-click way to keep the prompt cache hot without typing anything.
  In-flight requests dim the button and swap the label to `Sending...` until
  the prompt resolves. A `refreshInFlight` signal debounces rapid clicks so a
  single click can't queue multiple prompts. Hidden when the cache is COLD
  (clicking would pay full cold-cache tax for no benefit — the worst-case
  action this plugin exists to prevent); visible on HOT, WARNING, and BUSY.
- **Clickable "✨ New chat" button** in `session_prompt_right`. Creates a brand-
  new session seeded with a tiny continuation prompt built from the current
  session's last user message, last assistant reply, and up to five most-
  recently `read` file paths, then auto-navigates the TUI to that new session.
  The motivation is to give users an escape hatch from a stale, expensive
  session WITHOUT inheriting its cold-cache tax. Inherits the source session's
  model so the new chat picks up with the same provider/model. **Visible only
  on COLD** — on HOT/WARNING/BUSY the 90% hot-read discount makes continuing
  strictly cheaper than forking, so the button hides to avoid luring users into
  a more expensive path. (Users who want a clean fork on hot can still use the
  built-in `/new` slash command.) Per-click debouncing via `newChatInFlight`
  mirrors the Refresh button. While in-flight, the label shows an animated
  braille spinner (`Starting... ⠋`) on a dedicated 100ms interval — cold-cache
  TTFT on Opus can be 30-60s, and motion confirms the click registered.
- **Semantic `CacheState` enum** (`"hot" | "warning" | "cold" | "busy"`) written
  once per tick by the countdown loop and read by button visibility predicates.
  Replaces string-matching on the display label and makes future state /
  visibility rules a one-line change at the predicate site.
- **Inline button layout.** Buttons and timer text render on a single row via
  `flexDirection="row"` and `gap={1}` (order: New chat → Refresh → timer).

### Notes
- Mouse support depends on the host terminal: iTerm2, kitty, Alacritty,
  WezTerm, and modern Terminal.app all forward `onMouseUp` correctly.

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
