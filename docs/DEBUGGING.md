# Debugging notes & event learnings

This document captures what we learned about opencode's event stream and TUI
behaviour while building the cache-timer, and how we used file-based logging to
diagnose subtle timing bugs. The verbose instrumentation that produced these
findings has since been removed (it wrote to `/tmp/cache-timer-debug.log` every
second and grew to hundreds of MB), but the knowledge is worth keeping for the
next hard bug.

## How we debugged: file-based logging

opencode TUI plugins can't easily `console.log` to a visible place, and toasts
stack/obscure each other. The reliable tool was a tiny append-only file logger:

```ts
const DEBUG_LOG_PATH = "/tmp/cache-timer-debug.log";
function debugLog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* never throw from instrumentation */ }
}
```

Workflow that worked well:
- Log each relevant **event** with an ISO timestamp and the session id.
- Reproduce the bug live in the TUI, then `grep`/`awk` the log by timestamp
  window to reconstruct the exact ordering of events vs. ticks.
- Compare **timestamps across event types** (e.g. `question.rejected` at
  `:47.588` vs. the step-finish at `:47.655`) — millisecond gaps proved whether
  something was a real provider round-trip or a local finalization.

> WARNING: do NOT ship per-tick or per-step-finish logging. The 1s ticker and
> the step-finish stream are high-volume; leaving them on bloated the log to
> ~635MB in a single afternoon. Keep only event-driven, low-volume logs
> (config load, init, error `THREW` handlers, interaction lifecycle).

## opencode event stream — what's reliable

### Pending interactions: use EVENTS, not state pollers
`api.state.session.question(sessionID)` and `.permission(sessionID)` returned
**empty on every tick** across extensive captures in this opencode version.
They are not a reliable signal for "is a prompt pending".

The authoritative signal is the **event stream**:

| Event                 | Properties                              | Meaning                          |
| --------------------- | --------------------------------------- | -------------------------------- |
| `question.asked`      | `{ id, sessionID, questions[] }`        | Question tool prompt opened      |
| `question.replied`    | `{ sessionID, requestID, answers[] }`   | User answered                    |
| `question.rejected`   | `{ sessionID, requestID }`              | User cancelled                   |
| `permission.updated`  | `{ id, sessionID, ... }`                | Permission request opened        |
| `permission.replied`  | `{ sessionID, permissionID, response }` | Permission resolved              |

Track open requests in a `Map<sessionID, Set<requestID>>`, add on
`*.asked`/`*.updated`, clear on `*.replied`/`*.rejected`. Key by id (not a
boolean) so overlapping prompts in one session are reference-counted correctly.
These events **keep firing while a modal is open**, unlike the suspended slot
(see below).

### step-finish parts
`step-finish` arrives as a `message.part.updated` event whose `part.type ===
"step-finish"`. The part shape (this opencode/provider version):

```
{ id, reason, snapshot, messageID, sessionID, type,
  tokens: { total, input, output, reasoning, cache: { write, read } },
  cost }
```

- `reason` is e.g. `"tool-calls"` (the step ended by calling a tool, including
  the interactive Question tool) or a normal stop reason.
- `tokens.cache.read` is the **hot-cache hit** size; `tokens.cache.write` was
  **always 0** for this provider/config — cache hits surface as *reads*, not
  writes. So "did we hit cache" must key on a large `cache.read`, NOT on
  `cache.write`.
- A genuinely cold request shows `cache.read = 0` with a large `input`
  (full-price reprocessing of the whole history).

## The big gotchas (root causes we hit)

### 1. The active session's prompt slot is SUSPENDED while its modal is open
When a Question/permission modal is on screen, opencode **suspends the focused
session's `session_prompt_right` slot entirely** — its `setInterval` stops and
it does not re-render (verified: a ~46s tick gap exactly spanning a question;
other, non-focused sessions kept ticking the whole time, then the focused slot
**remounts** on resolve).

Consequences:
- Anything that must update *during* a modal (e.g. cold-cache warnings) cannot
  live in the slot. We moved it to a **module-level `setInterval`** that runs
  for the whole TUI lifetime and reads global state.
- Toasts work during a modal because `api.ui.toast` is a **separate surface**,
  not the suspended slot.
- The inline timer text genuinely *cannot* repaint during the active session's
  own modal. That's a constraint, not a fixable bug.

### 2. `time.completed` and step-finish arrival are RESTAMPED at turn-resolution
This was the subtle one. For a turn that posed a Question, the assistant
message's timestamps behave very differently:

- `time.created` — stamped when the provider **starts** responding (≈ when the
  prompt-cache window resets). **Stable; never restamped.**
- `time.completed` — stamped when the **turn resolves**, i.e. after the user
  answers/cancels. For an interactive turn this is delayed by however long the
  user sat on the prompt.
- step-finish **arrival time** — the step-finish part is delivered *late*, at
  turn-resolution, and (since the part carries no timestamp) we'd stamped it
  with `Date.now()` on arrival — also late.

Observed in one capture: `time.created = :40:05` while both `time.completed` and
the step-finish arrived at `:40:50` — a **45-second lie**. Anchoring the cache
math on `time.completed`/step-finish made the timer falsely reset to FULL the
moment a question resolved, masking a genuinely cold cache (that same turn was
`cache.read = 0, input = 101838` — a full-price cold read).

**Fix:** anchor cache math on the newest **assistant** message's
`time.created`. It tracks the real provider-response start and never restamps.
Multi-round-trip turns stay correct because opencode creates a **new assistant
message (fresh `time.created`) per provider round-trip** — verified: each
step-finish carried a distinct `messageID`. So the newest message's
`time.created` already reflects the most recent provider response, including
mid-turn refreshes. The step-finish arrival anchor became unnecessary and was
removed.

Discriminators we logged to prove this (now removed):
- `createdToArrival = arrival - msg.time.created` — large (tens of seconds) for
  a late finalization; small for a real, prompt response.
- `completedToArrival`, `reason`, and the full token breakdown.

### 3. Resolving a question does NOT make a new provider round-trip
A step-finish fired ~67–93ms after `question.rejected` — far too fast to be a
network round-trip. It was the **posing turn finalizing** (flushing the tokens
the model already generated when it called the Question tool), delivered late.
The model produces no *new* response merely from a reject (UI shows only a
strike-through on "Asked 1 question").

### 4. A new toast clears ALL existing toasts
opencode clears every visible toast whenever a new one is emitted — even a toast
with a multi-minute/hour duration. We exploit this deliberately:
- The cold-cache "pending prompt" toast uses a **24h duration** so a user
  returning from lunch/overnight still sees it.
- When the prompt resolves we emit a **near-invisible sweeper toast** (blank
  title/message, `duration: 1`) whose only job is to clear the lingering one.
  We intentionally do NOT say "cache refreshed" — that would be false on cancel
  or when the cache is still cold.

### 5. Slot `onCleanup` can RACE module-level state (reply vs. reject bug)
Symptom: the lingering cold toast was swept on **reject** but not on **reply**.

Cause: on reply, the assistant's turn continues, the modal closes, and the slot
**remounts**. The old slot instance's `onCleanup` ran during the remount and
deleted the session from the toast dedupe sets — winning a race against the
module-level watcher's re-arm loop and **stealing the resolve signal**, so the
sweeper never fired. On reject the turn ended and the watcher won the race.

**Fix:** make the module-level watcher the *sole owner* of that state; do not
mutate shared module state from a per-slot `onCleanup` when a global loop also
manages it. Remounts will run `onCleanup` at surprising times.

## General principles that fell out of this

- **Prefer module-level intervals over slot intervals** for anything that must
  survive a modal or run independently of which session is focused.
- **One owner per piece of shared module state.** Don't clear it from both a
  slot lifecycle hook and a global loop — remounts cause races.
- **Timestamps are not all equal.** `time.created` (provider-start) vs.
  `time.completed` (turn-resolution) differ by the entire interactive wait;
  pick the one that matches the physical thing you're measuring (here, the
  cache TTL clock, which starts at provider-start).
- **Verify with the provider's own ground truth** (`tokens.cache.read`/`input`)
  rather than inferring cold/hot from timestamps alone.
- **Compare event timestamps in milliseconds** to distinguish a real network
  round-trip from a local finalization.
