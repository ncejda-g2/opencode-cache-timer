/** @jsxImportSource @opentui/solid */
import { type JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { appendFileSync, readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Single source of truth for the displayed version. Keep this in sync with
// package.json on release; surfacing it in the load toast is a cheap way to
// verify which build is actually running (especially useful when iterating
// against the cached npm install under ~/.cache/opencode/packages).
const CACHE_TIMER_VERSION = "1.2.0-question-test.12"

// DEBUG: file-based logger. Useful when toast stacking obscures init details
// and as a permanent troubleshooting aid for the cache-timer config loader.
// Safe to leave in; never throws (writes silently to /tmp).
const DEBUG_LOG_PATH = "/tmp/cache-timer-debug.log";
function debugLog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Intentionally swallow; debug instrumentation must never break the plugin.
  }
}

// Shape of the optional sidecar config file users can drop next to opencode.json.
interface CacheTimerConfig {
  enableAutoPrompt?: boolean;
  defaultDuration?: number;
  durations?: Record<string, number>;
}

// Read cache-timer config from a sidecar JSON file. Surveys of real opencode
// plugins (opencode-dcp, opencode-vibeguard, opencode-sentry-monitor,
// opencode-notificator, etc.) confirm that the inline `["file://path", {...}]`
// tuple form in opencode.json's `plugin` array does NOT actually forward the
// options object to TUI plugins in released opencode (1.15.x). Every config-
// heavy plugin in the ecosystem instead reads its own sidecar file with the
// plugin's slug as the filename. We follow that established pattern.
//
// Search order matches opencode's own project-then-global precedence:
//   1. ./.opencode/cache-timer.json   (project override)
//   2. ~/.config/opencode/cache-timer.json  (global)
function loadCacheTimerConfig(): CacheTimerConfig {
  const candidatePaths = [
    join(process.cwd(), ".opencode", "cache-timer.json"),
    join(homedir(), ".config", "opencode", "cache-timer.json"),
  ];

  const merged: CacheTimerConfig = {};
  for (const path of candidatePaths) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        debugLog(`loaded cache-timer config from ${path}: ${JSON.stringify(parsed)}`);
        // Project-level (encountered first) wins over global for scalar fields.
        if (merged.enableAutoPrompt === undefined && typeof parsed.enableAutoPrompt === "boolean") {
          merged.enableAutoPrompt = parsed.enableAutoPrompt;
        }
        if (merged.defaultDuration === undefined && typeof parsed.defaultDuration === "number") {
          merged.defaultDuration = parsed.defaultDuration;
        }
        // For the durations map, project values win per-key.
        if (parsed.durations && typeof parsed.durations === "object") {
          merged.durations = { ...parsed.durations, ...(merged.durations ?? {}) };
        }
      }
    } catch (err) {
      debugLog(`failed to read/parse ${path}: ${String(err)}`);
    }
  }
  return merged;
}

// Default model cache durations in seconds, keyed by *provider family*.
// The matcher in getCacheDuration() does a case-insensitive substring match
// against the model id, so a single family key (e.g. "claude") covers every
// variant of that family (claude-3-5-sonnet, claude-opus-4-7, claude-haiku-4-5,
// etc.). Users override per-family via opencode.json `options.durations`.
let cacheDurations: Record<string, number> = {
  "claude": 300,
  "gemini": 300,
  "gpt": 300,
};
let defaultDuration = 300; // Fallback to 5 minutes (300s)

// Helper to determine cache duration for a specific model ID
function getCacheDuration(modelId: string | undefined): number {
  if (!modelId) return defaultDuration;
  
  const normalizedId = modelId.toLowerCase();
  for (const [key, duration] of Object.entries(cacheDurations)) {
    if (normalizedId.includes(key)) {
      return duration;
    }
  }
  return defaultDuration;
}

// Compute remaining prompt-cache seconds for a session from module-global state,
// independent of any TUI slot. Used by the global interaction watcher (the
// per-slot ticker is suspended while a Question/permission modal is open, so it
// cannot drive the cold-cache toasts during exactly the window they matter).
// Mirrors the slot ticker's freshest-anchor logic: max(step-finish arrival,
// newest assistant-message timestamp). Returns undefined if no anchor is known.
function remainingCacheSecondsFor(api: TuiPluginApi, sessionID: string): number | undefined {
  let messages: ReadonlyArray<any> | undefined;
  try {
    messages = api.state.session.messages(sessionID);
  } catch {
    return undefined;
  }

  // Newest assistant message: model id + timestamp anchor.
  //
  // ANCHOR = newest assistant message's time.CREATED (not time.completed, not
  // step-finish arrival). Proven via instrumentation (v1.2.0-question-test.4):
  // for a turn that posed a Question/permission, the assistant message's
  // time.created is stamped when the provider STARTS responding (the moment the
  // prompt-cache window resets), while time.completed AND the step-finish
  // arrival are both restamped at turn-RESOLUTION — which for an interactive
  // turn is delayed by the entire time the user sat on the prompt (observed:
  // created=13:40:05 vs completed/step-finish=13:40:50, a 45s lie). Anchoring on
  // those restamped values falsely reset the timer to FULL on resolve, masking a
  // genuinely cold cache (that turn was cacheRead=0, input=101838 — a full-price
  // cold read). time.created never restamps, so it is the only correct anchor.
  //
  // Multi-round-trip turns are handled correctly because opencode creates a NEW
  // assistant message (with a fresh time.created) for every provider round-trip
  // (verified: each step-finish carries a distinct messageID). So the NEWEST
  // assistant message's time.created tracks the most recent provider response —
  // including mid-turn cache refreshes — without needing the unreliable
  // step-finish arrival stamp.
  let modelId: string | undefined;
  let messageAnchor: number | undefined;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      if (m.role !== "assistant") continue;
      if (modelId === undefined) modelId = m.modelID;
      const t = m.time?.created ?? m.time?.completed;
      if (t) { messageAnchor = t; break; }
    }
  }

  if (messageAnchor === undefined) return undefined;

  const durationSec = getCacheDuration(modelId);
  return Math.round((durationSec * 1000 - (Date.now() - messageAnchor)) / 1000);
}

// Build the seed prompt for a brand-new chat that picks up where a stale
// session left off WITHOUT inheriting the cold-cache tax of that session.
//
// The shape is intentionally minimal: the goal is to give the assistant just
// enough context to ask a useful "what next?" question, NOT to recreate the
// prior conversation. We pull three things from the source session via
// `api.state` (cheap, in-memory; no extra API round-trips):
//
//   1. The text of the most recent user message
//   2. The text of the most recent assistant reply
//   3. Up to 5 file paths the model has most recently `read` (the read tool's
//      `filePath` input parameter — falling back to `path` for safety across
//      tool schema versions)
//
// Returns null when there isn't a coherent last exchange (no user message,
// no assistant message) — in that case the caller should suppress the
// "New chat" button entirely rather than seed an empty/awkward prompt.
function buildSeedPrompt(
  api: TuiPluginApi,
  sourceSessionID: string,
): string | null {
  const messages = api.state.session.messages(sourceSessionID);
  if (!messages || messages.length === 0) return null;

  // Find the last user and last assistant messages. We scan from the tail so
  // an in-flight assistant reply (currently streaming) is preferred over an
  // older completed one, matching the user's mental model of "the assistant's
  // most recent response".
  let lastUserMsg: typeof messages[number] | undefined;
  let lastAssistantMsg: typeof messages[number] | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!lastAssistantMsg && m.role === "assistant") lastAssistantMsg = m;
    if (!lastUserMsg && m.role === "user") lastUserMsg = m;
    if (lastUserMsg && lastAssistantMsg) break;
  }
  if (!lastUserMsg || !lastAssistantMsg) return null;

  // Extract text content from a message's parts. Messages themselves carry no
  // text — text lives in TextPart records addressed by messageID. We join all
  // text parts (a single assistant turn can emit multiple text parts when
  // tool calls are interleaved) and skip synthetic/ignored ones.
  const messageText = (messageID: string): string => {
    const parts = api.state.part(messageID);
    if (!parts) return "";
    const chunks: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && !p.synthetic && !p.ignored) {
        chunks.push(p.text);
      }
    }
    return chunks.join("\n").trim();
  };

  const lastUserText = messageText(lastUserMsg.id);
  const lastAssistantText = messageText(lastAssistantMsg.id);

  // Collect the most recently read file paths across the whole session.
  // `read` is opencode's built-in file-read tool; its `input.filePath` is the
  // absolute path. We walk messages newest -> oldest and dedupe, preserving
  // first-seen order so the list reflects recency. Capped at 5 to keep the
  // seed prompt small (we paid the cost of cold-starting a new session
  // precisely to keep this prompt tiny).
  const recentReadFiles: string[] = [];
  const seenPaths = new Set<string>();
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const parts = api.state.part(messages[i].id);
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part.type !== "tool") continue;
      if (part.tool !== "read") continue;
      // Tool input keys have varied across opencode versions; check both
      // `filePath` (current) and `path` (older) before giving up.
      const input = part.state?.input as Record<string, unknown> | undefined;
      const candidate =
        (typeof input?.filePath === "string" ? input.filePath : undefined) ??
        (typeof input?.path === "string" ? input.path : undefined);
      if (!candidate) continue;
      if (seenPaths.has(candidate)) continue;
      seenPaths.add(candidate);
      recentReadFiles.push(candidate);
      if (recentReadFiles.length >= 5) break outer;
    }
  }

  const filesBlock =
    recentReadFiles.length > 0
      ? recentReadFiles.map((p) => `- ${p}`).join("\n")
      : "(none recorded)";

  return [
    "We are continuing from a previous work session. But we don't know yet what the user wants to do next.",
    "",
    `The last user request was:`,
    lastUserText || "(no text content recorded)",
    "",
    `The agent responded to that request with:`,
    lastAssistantText || "(no text content recorded)",
    "",
    `The most-recently-referenced documents were:`,
    filesBlock,
    "",
    "Ask the user what they would like to work on next given this context.",
  ].join("\n");
}

// Helper to format remaining seconds as MM:SS
function formatTimeText(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const calculatedSeconds = Math.floor(totalSeconds % 60)
  return `${String(minutes).padStart(2, "0")}:${String(calculatedSeconds).padStart(2, "0")}`
}

// Cache state is the *semantic* signal that the ticker derives every second.
// All UI affordances (text, color, button visibility) read from this single
// enum instead of string-matching on the display label. Keeping it explicit
// also makes it cheap to add new states (e.g. "expired-grace") later without
// hunting through conditional UI code.
// "busy"      — turn running, cache still hot/warning (live countdown shown).
// "busy-cold" — turn running BUT the provider cache has already expired. The
//               cache truth (COLD) wins over the local busy status; the only
//               available action is Interrupt-then-fork.
type CacheState = "hot" | "warning" | "cold" | "busy" | "busy-cold";

// Module-level session-keyed states to ensure absolute isolation across multiple sessions
const triggeredSessions = new Set<string>();
const healthySessions = new Set<string>();
const lastUserMsgIds = new Map<string, string>();
const autoPromptIds = new Set<string>(); // Immutable ledger of all generated auto-prompt message IDs

// Question-pending toast dedupe. Both Sets hold session IDs that have ALREADY
// had the corresponding toast fired during the *current* pending-question
// episode. We add on fire, and clear both when the question list goes empty
// (the user answered/cancelled). This re-arm-on-resolve pattern means:
//
//   - A single question that lingers across warning -> cold gets exactly one
//     warning toast AND exactly one cold toast (not one of each per tick).
//   - If a user lets multiple questions queue up across a long break, each
//     new pending-question episode gets its own fresh pair of toasts —
//     because the previous episode's resolve cleared the dedupe entries.
//
// Why two Sets, not one: warning and cold are distinct semantic events. A
// session can enter warning, fire its warning toast, then enter cold and
// still need to fire its cold toast — the user has not "seen the warning"
// in any way that obviates the cold notification.
const warningToastFiredSessions = new Set<string>();
const coldToastFiredSessions = new Set<string>();

// Pending interactive prompts (Question tool AND permission requests), keyed by
// sessionID -> set of request/permission IDs awaiting the user.
//
// WHY EVENTS, NOT POLLING: the TUI state pollers `api.state.session.question()`
// and `.permission()` returned empty on every tick across extensive captures —
// they are not reliable in this opencode version. The authoritative signal is
// the event stream: opencode emits `question.asked`/`question.replied`/
// `question.rejected` and `permission.updated`/`permission.replied`. We track
// open requests here and clear them on reply/reject, giving the ticker a
// dependable "is an interaction pending" signal for both the countdown and the
// cold-cache toasts. We key by ID (not a boolean) so overlapping prompts in one
// session are reference-counted correctly.
const pendingInteractions = new Map<string, Set<string>>();

function addPendingInteraction(sessionID: string, requestID: string): void {
  if (!sessionID || !requestID) return;
  let set = pendingInteractions.get(sessionID);
  if (!set) {
    set = new Set<string>();
    pendingInteractions.set(sessionID, set);
  }
  set.add(requestID);
}

function clearPendingInteraction(sessionID: string, requestID: string): void {
  if (!sessionID) return;
  const set = pendingInteractions.get(sessionID);
  if (!set) return;
  if (requestID) set.delete(requestID);
  if (set.size === 0) pendingInteractions.delete(sessionID);
}

function hasPendingInteraction(sessionID: string): boolean {
  const set = pendingInteractions.get(sessionID);
  return !!set && set.size > 0;
}

// When we fire an auto-summary, we record the user-message count of the session
// AT trigger time. The next user message that appears beyond this count is
// definitionally the auto-prompt itself, so we ledger it as auto regardless of
// whether the session was "busy" during ledgering or whether the prompt API
// promise has already resolved. This eliminates the race where the auto-prompt's
// user-message id was never ledgered (because ticks during busy state were
// skipped) and was then incorrectly treated as a human input on the next tick,
// causing the trigger to re-arm and the summary to fire again in an infinite loop.
const pendingAutoPromptUserCount = new Map<string, number>();

const tui: TuiPlugin = async (api, _options, _meta) => {
  // Auto-prompt is opt-in. Defaults stay safe.
  let enableAutoPrompt = false;

  debugLog("=== tui() invoked ===");
  const userConfig = loadCacheTimerConfig();
  debugLog(`resolved userConfig=${JSON.stringify(userConfig)}`);

  if (typeof userConfig.defaultDuration === "number") {
    defaultDuration = userConfig.defaultDuration;
  }
  if (userConfig.durations) {
    cacheDurations = { ...cacheDurations, ...userConfig.durations };
  }
  if (typeof userConfig.enableAutoPrompt === "boolean") {
    enableAutoPrompt = userConfig.enableAutoPrompt;
  }

  debugLog(`post-merge cacheDurations=${JSON.stringify(cacheDurations)} enableAutoPrompt=${enableAutoPrompt} defaultDuration=${defaultDuration}`);

  // Defensive wrap: OpenCode's TUI API has been adding required fields between
  // minor versions (e.g. `message` became mandatory on toasts in v1.15.x).
  // If validation throws here, swallow it so the slot registration below still
  // runs — losing a load toast is better than losing the entire countdown.
  try {
    api.ui.toast({
      variant: "success",
      title: `Cache Timer v${CACHE_TIMER_VERSION} loaded`,
      message: `Auto-prompt: ${enableAutoPrompt ? "on" : "off"}`,
      duration: 3000,
    })
  } catch (e: any) {
    debugLog(`api.ui.toast THREW: ${e?.message || e}`);
  }

  try {
    // Pending-interaction tracking via the event stream (the authoritative
    // signal — the question()/permission() state pollers proved unreliable).
    //
    // Question tool lifecycle: question.asked -> question.replied|rejected.
    //   question.asked   props = QuestionRequest { id, sessionID, questions[] }
    //   question.replied props = { sessionID, requestID, answers[] }
    //   question.rejected props = { sessionID, requestID }
    api.event.on("question.asked", (event: any) => {
      try {
        const p = event?.properties ?? {};
        if (p.sessionID && p.id) {
          addPendingInteraction(p.sessionID, p.id);
          debugLog(`question.asked session=${p.sessionID} id=${p.id}`);
        }
      } catch (innerErr) {
        debugLog(`question.asked handler THREW: ${String(innerErr)}`);
      }
    });
    for (const evt of ["question.replied", "question.rejected"]) {
      api.event.on(evt, (event: any) => {
        try {
          const p = event?.properties ?? {};
          if (p.sessionID) {
            clearPendingInteraction(p.sessionID, p.requestID);
            debugLog(`${evt} session=${p.sessionID} requestID=${p.requestID}`);
          }
        } catch (innerErr) {
          debugLog(`${evt} handler THREW: ${String(innerErr)}`);
        }
      });
    }

    // Permission lifecycle: permission.updated -> permission.replied.
    //   permission.updated  props = Permission { id, sessionID, ... }
    //   permission.replied  props = { sessionID, permissionID, response }
    api.event.on("permission.updated", (event: any) => {
      try {
        const p = event?.properties ?? {};
        if (p.sessionID && p.id) {
          addPendingInteraction(p.sessionID, p.id);
          debugLog(`permission.updated session=${p.sessionID} id=${p.id}`);
        }
      } catch (innerErr) {
        debugLog(`permission.updated handler THREW: ${String(innerErr)}`);
      }
    });
    api.event.on("permission.replied", (event: any) => {
      try {
        const p = event?.properties ?? {};
        if (p.sessionID) {
          clearPendingInteraction(p.sessionID, p.permissionID);
          debugLog(`permission.replied session=${p.sessionID} permissionID=${p.permissionID}`);
        }
      } catch (innerErr) {
        debugLog(`permission.replied handler THREW: ${String(innerErr)}`);
      }
    });

    debugLog("registered event listeners (question.*, permission.*)");
  } catch (e: any) {
    debugLog(`api.event.on THREW: ${e?.message || e}`);
  }

  // GLOBAL interaction-toast watcher (module-level, NOT per-slot).
  //
  // Why this can't live in the slot ticker: when a Question/permission modal is
  // open, the focused session's `session_prompt_right` slot is suspended — its
  // setInterval stops firing for the entire duration of the prompt (verified:
  // ~46s tick gap exactly spanning a question). That is precisely the window the
  // cold-cache toasts are meant for, so they must be driven independently.
  //
  // This single interval runs for the whole TUI lifetime. Each second it visits
  // every session with a pending interaction (populated by the question.*/
  // permission.* event handlers, which keep firing while the modal is open) and
  // toasts as the cache crosses WARNING (<60s) and COLD (<=0). Dedupe sets keep
  // each toast to once per pending episode; they re-arm when the interaction
  // resolves (the session drops out of pendingInteractions).
  try {
    const interactionWatcher = setInterval(() => {
      try {
        // Re-arm dedupes for sessions that no longer have a pending interaction,
        // AND sweep away the (possibly very long-lived) warning/cold toast that
        // we fired for that episode.
        //
        // The cold toast has a 24h duration so it survives a long absence, which
        // means it will NOT clear itself when the user answers/cancels. We rely
        // on opencode clearing all existing toasts whenever a new toast is
        // emitted: the moment a session that had a fired toast resolves, we emit
        // a near-invisible "sweeper" toast (1ms, blank text) whose only job is to
        // clear the lingering one. We deliberately do NOT say "cache refreshed" —
        // that would be a lie on cancel or when the cache is still cold.
        const resolvedSessions = new Set<string>();
        for (const sid of Array.from(warningToastFiredSessions)) {
          if (!hasPendingInteraction(sid)) {
            warningToastFiredSessions.delete(sid);
            resolvedSessions.add(sid);
          }
        }
        for (const sid of Array.from(coldToastFiredSessions)) {
          if (!hasPendingInteraction(sid)) {
            coldToastFiredSessions.delete(sid);
            resolvedSessions.add(sid);
          }
        }
        if (resolvedSessions.size > 0) {
          // One sweeper is enough — emitting a single toast clears ALL existing
          // toasts regardless of how many sessions resolved this tick.
          try {
            api.ui.toast({
              variant: "info",
              title: " ",
              message: " ",
              duration: 1,
            });
            debugLog(`resolve-sweeper fired for sessions=${JSON.stringify(Array.from(resolvedSessions))}`);
          } catch (sweepErr) {
            debugLog(`resolve-sweeper THREW: ${String(sweepErr)}`);
          }
        }

        for (const [sid, set] of pendingInteractions) {
          if (!set || set.size === 0) continue;
          const remaining = remainingCacheSecondsFor(api, sid);
          if (remaining === undefined) continue;

          if (remaining <= 0) {
            if (!coldToastFiredSessions.has(sid)) {
              coldToastFiredSessions.add(sid);
              api.ui.toast({
                variant: "info",
                title: "Cache cold",
                message: "Cache has expired while a prompt is pending. Consider ✨ New chat / Stop & fork instead of answering, to avoid paying the cold-start tax.",
                // Very long (24h) so a user returning from a long break — lunch,
                // overnight — still sees the cold-cache warning. It is NOT meant
                // to time out on its own; it is swept away the instant the prompt
                // resolves (see the resolve-sweeper in the re-arm loop below),
                // which exploits opencode's behavior of clearing all existing
                // toasts whenever a new toast is emitted.
                duration: 86_400_000,
              });
            }
          } else if (remaining < 60) {
            if (!warningToastFiredSessions.has(sid)) {
              warningToastFiredSessions.add(sid);
              api.ui.toast({
                variant: "warning",
                title: "Cache nearly cold",
                message: "Cache expires in <1 min. Answer or dismiss the prompt soon to avoid the cold-start tax.",
                duration: 60_000,
              });
            }
          }
        }
      } catch (innerErr) {
        debugLog(`interactionWatcher tick THREW: ${String(innerErr)}`);
      }
    }, 1000);
    // Never cleaned up: lives for the TUI process lifetime, like the event
    // listeners above. There is no teardown hook at this scope.
    void interactionWatcher;
    debugLog("started global interaction-toast watcher");
  } catch (e: any) {
    debugLog(`interactionWatcher setup THREW: ${e?.message || e}`);
  }

  // Defensive wrap on slot registration for the same reason as above.
  try {
  api.slots.register({
    slots: {
      session_prompt_right(ctx, value) {
        // Resolve initial active model duration
        const session_id = value?.session_id;
        const messagesOnMount = api.state.session.messages(session_id);
        let initialDuration = defaultDuration;
        if (messagesOnMount && messagesOnMount.length > 0) {
          const lastMsg = messagesOnMount[messagesOnMount.length - 1];
          const modelId = lastMsg.role === "user" ? lastMsg.model?.modelID : lastMsg.modelID;
          initialDuration = getCacheDuration(modelId);
        }

        const [timeText, setTimeText] = createSignal(`Cache: HOT (${formatTimeText(initialDuration)})`)
        const [color, setColor] = createSignal("#EF4444") // Red (HOT)
        // Semantic cache state. The ticker is the single writer; both buttons
        // read it to decide their own visibility. See CacheState type comment.
        const [cacheState, setCacheState] = createSignal<CacheState>("hot")
        // Track whether the source session has any messages yet. Required for
        // the "New chat" button: there's nothing to seed from in an empty
        // session, so we hide the button rather than emit an empty seed prompt.
        const [hasMessages, setHasMessages] = createSignal(messagesOnMount && messagesOnMount.length > 0)

        // Per-button in-flight flags guard against double-clicks spamming the
        // session (the prompt/create APIs are async; a second click before the
        // first resolves would race and undo our cache-preservation goal).
        const [refreshInFlight, setRefreshInFlight] = createSignal(false)
        const [newChatInFlight, setNewChatInFlight] = createSignal(false)
        const [interruptInFlight, setInterruptInFlight] = createSignal(false)

        // Animated spinner frame driver for the "Starting..." button label.
        // Cold-cache TTFT on Opus via LiteLLM can be 30-60s; without motion
        // the button looks frozen and users wonder if the click registered.
        // Dedicated interval (not the 1s ticker) for 100ms frames; gated on
        // newChatInFlight so it only burns CPU during the brief in-flight
        // window. Cleared in onCleanup with the main ticker.
        const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        const [spinnerFrame, setSpinnerFrame] = createSignal(0)
        let spinnerInterval: ReturnType<typeof setInterval> | null = null
        const startSpinner = () => {
          if (spinnerInterval) return
          spinnerInterval = setInterval(() => {
            setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)
          }, 100)
        }
        const stopSpinner = () => {
          if (spinnerInterval) {
            clearInterval(spinnerInterval)
            spinnerInterval = null
          }
          setSpinnerFrame(0)
        }

        const handleRefreshClick = () => {
          if (!session_id) return
          if (refreshInFlight()) return // debounce: ignore if already sending
          setRefreshInFlight(true)

          api.client.session.prompt({
            sessionID: session_id,
            parts: [{
              type: "text",
              text: "Output only and exactly the words 'Refreshed cache.'"
            }]
          }).then(() => {
            api.ui.toast({
              variant: "success",
              title: "Refresh Sent",
              message: "Cache refresh prompt dispatched.",
              duration: 3000,
            });
          }).catch((err) => {
            api.ui.toast({
              variant: "error",
              title: "Refresh Failed",
              message: String(err?.message || err),
              duration: 5000,
            });
          }).finally(() => {
            setRefreshInFlight(false)
          });
        }

        // Start a brand-new session seeded with a tiny "continuation" prompt
        // built from the last exchange (and last 5 read files) of the current
        // session. The point is to AVOID paying the cold-cache tax of
        // revalidating the current session's full history — a fresh session
        // with a small seed is cheaper than reviving a stale 100K-token
        // context.
        //
        // Flow: build seed -> create session -> send prompt -> navigate.
        // Each step is awaited so we can surface a precise toast on failure
        // and never leave the user on a half-created orphan session.
        const handleNewChatClick = async () => {
          if (!session_id) return
          if (newChatInFlight()) return
          setNewChatInFlight(true)
          startSpinner()

          try {
            const seed = buildSeedPrompt(api, session_id)
            if (!seed) {
              api.ui.toast({
                variant: "info",
                title: "Nothing to Continue",
                message: "Need at least one user + assistant exchange to start a new chat.",
                duration: 3000,
              })
              return
            }

            // Inherit the source session's active model so the new chat uses
            // the same provider/model the user was already working with. The
            // model lives on the user message (set by opencode at submit time)
            // — we look it up from the most recent user message in history.
            const messages = api.state.session.messages(session_id)
            let inheritModel:
              | { id: string; providerID: string; variant?: string }
              | undefined
            if (messages) {
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i]
                if (m.role === "user" && m.model?.modelID && m.model.providerID) {
                  inheritModel = {
                    id: m.model.modelID,
                    providerID: m.model.providerID,
                    variant: m.model.variant,
                  }
                  break
                }
              }
            }

            const createResult: any = await api.client.session.create({
              ...(inheritModel ? { model: inheritModel } : {}),
              title: "Continued chat",
            })
            const newSession: any = createResult?.data ?? createResult
            const newSessionID: string | undefined = newSession?.id
            if (!newSessionID) {
              throw new Error("session.create returned no session id")
            }

            // Navigate FIRST, then fire the seed prompt as fire-and-forget.
            //
            // Why: `session.prompt` only resolves when the assistant's turn
            // completes. If the LLM uses an interactive tool (e.g. Question)
            // mid-turn, the promise hangs until the user answers — which they
            // can't, because we haven't navigated yet. Awaiting it here would
            // strand the user on the old session with a spinner that never
            // stops. See v1.1.0 bug: "New chat spinner spins forever when the
            // new session's first reply uses the Question tool."
            //
            // Decoupling navigate from prompt-completion makes the UX
            // predictable regardless of what the assistant does in the new
            // session. Errors from the detached prompt surface as a toast.
            try {
              api.route.navigate("session", { sessionID: newSessionID })
            } catch (navErr) {
              debugLog(`route.navigate failed: ${String(navErr)}`)
            }

            api.client.session.prompt({
              sessionID: newSessionID,
              parts: [{ type: "text", text: seed }],
            }).catch((promptErr: any) => {
              debugLog(`new-chat seed prompt failed: ${String(promptErr?.message || promptErr)}`)
              api.ui.toast({
                variant: "error",
                title: "Seed Prompt Failed",
                message: String(promptErr?.message || promptErr),
                duration: 5000,
              })
            })

            api.ui.toast({
              variant: "success",
              title: "New Chat Started",
              message: "Continuing in a fresh session with hot-cache-friendly context.",
              duration: 3000,
            })
          } catch (err: any) {
            api.ui.toast({
              variant: "error",
              title: "New Chat Failed",
              message: String(err?.message || err),
              duration: 5000,
            })
          } finally {
            // Clear in-flight as soon as create+navigate finish — we are NOT
            // waiting for the assistant's turn. The spinner now only spans
            // the create call (sub-second), not the full LLM turn.
            setNewChatInFlight(false)
            stopSpinner()
          }
        }

        // Interrupt-and-fork. Surfaced only in the "busy-cold" state: the turn
        // is still running but the provider cache has already expired, so
        // resuming would pay the cold-start tax against a stale, bloated
        // context. Aborting first frees the session, then we fork a fresh chat
        // seeded from the interrupted output (cheaper than reviving the cold
        // session). Abort then reuse the exact New-chat flow.
        const handleInterruptClick = async () => {
          if (!session_id) return
          if (interruptInFlight()) return
          setInterruptInFlight(true)
          try {
            try {
              await api.client.session.abort({ sessionID: session_id })
            } catch (abortErr: any) {
              debugLog(`session.abort failed: ${String(abortErr?.message || abortErr)}`)
              api.ui.toast({
                variant: "error",
                title: "Interrupt Failed",
                message: String(abortErr?.message || abortErr),
                duration: 5000,
              })
              return
            }
            api.ui.toast({
              variant: "info",
              title: "Session Interrupted",
              message: "Stopped the running turn before it pays the cold-cache tax. Forking a fresh chat from the interrupted output.",
              duration: 4000,
            })
            // Fork from the interrupted output. Reuses the New-chat path, which
            // builds a small seed, creates+navigates to a fresh session, and
            // fires the seed prompt fire-and-forget.
            await handleNewChatClick()
          } finally {
            setInterruptInFlight(false)
          }
        }

        // Local interval ticker that directly updates this component's reactive signals.
        // This guarantees the UI text updates flawlessly and never freezes.
        //
        // Extracted into a named function (rather than an inline arrow) so we can
        // invoke it ONCE synchronously at mount, before the 1s interval starts.
        // Without that priming call, the signals would render their optimistic
        // seed value ("HOT (max duration)") for up to a full second on mount —
        // and again whenever the slot remounts (e.g. when a message is queued) —
        // producing a one-frame flash to full before the first tick corrects it.
        // Priming computes the true value immediately so the first painted frame
        // is already correct.
        const runTick = () => {
          if (!session_id) return

          try {
            const sessionStatus = api.state.session.status(session_id);
            const messages = api.state.session.messages(session_id);

            // User-message ledgering MUST run every tick, including while the session
            // is busy. If we skip it during busy, the auto-prompt's user-message id
            // never gets recorded as "auto", and the next non-busy tick sees a "new"
            // user message it treats as human, clearing the trigger lock and causing
            // the auto-summary to fire again on the next cycle (infinite loop).
            if (messages && messages.length > 0) {
              const userMessages = messages.filter(m => m.role === "user");
              if (userMessages.length > 0) {
                const lastUserMsg = userMessages[userMessages.length - 1];
                const prevUserMsgId = lastUserMsgIds.get(session_id);
                if (lastUserMsg.id && prevUserMsgId !== lastUserMsg.id) {
                  lastUserMsgIds.set(session_id, lastUserMsg.id);

                  // Is this new user message ours (the auto-prompt) or a human's?
                  // It's ours iff:
                  //   (a) we have a pending auto-prompt snapshot for this session, AND
                  //   (b) the current user-message count exceeds that snapshot.
                  const expectedAutoCount = pendingAutoPromptUserCount.get(session_id);
                  const isAutoPrompt =
                    expectedAutoCount !== undefined &&
                    userMessages.length > expectedAutoCount;

                  if (isAutoPrompt) {
                    autoPromptIds.add(lastUserMsg.id);
                    // Consume the pending snapshot; further user messages beyond
                    // this point are real humans and should re-arm the trigger.
                    pendingAutoPromptUserCount.delete(session_id);
                  } else if (prevUserMsgId && !autoPromptIds.has(lastUserMsg.id)) {
                    // A human sent a fresh prompt: re-arm the auto-summary trigger.
                    triggeredSessions.delete(session_id);
                  }
                }
              }
            }

            // Keep `hasMessages` in sync every tick. Used by the New chat
            // button to decide whether there's anything worth continuing from.
            setHasMessages(!!messages && messages.length > 0)

            // If the session is actively processing or streaming, keep the
            // countdown LIVE instead of freezing it.
            //
            // The prompt-cache TTL clock starts when the provider finishes
            // responding (the step-finish), NOT when the assistant turn
            // completes. During a long-running local tool call (e.g. a bash
            // sleep/watch) the turn stays "busy" for the entire call while the
            // provider has already gone silent and its cache clock is ticking.
            // Freezing the display here hid a real countdown — and the cache
            // could silently expire mid-turn with the UI still showing "HOT".
            //
            // CACHE STATE IS THE SOURCE OF TRUTH. "Busy" is opencode's local
            // execution status and must never override the cache reality. If
            // the provider cache is cold, the user sees COLD — full stop — so
            // they can make an informed call (interrupt and fork from the
            // interrupted output, or let the long task finish and knowingly pay
            // the cold-start tax).
            //
            // Anchor selection: the newest ASSISTANT message's time.CREATED.
            //
            // time.created is stamped the moment the provider STARTS responding
            // (≈ request received, prompt-cache window reset). We previously also
            // consulted time.completed and the step-finish arrival time and took
            // the max(), but instrumentation (v1.2.0-question-test.4) proved both
            // of those are restamped at turn-RESOLUTION, not provider-response
            // time. For a turn that posed a Question/permission, resolution is
            // delayed by however long the user sat on the prompt, so both signals
            // jumped to ~now on resolve and falsely reset the timer to FULL —
            // masking a genuinely cold cache (observed: created=:05 vs
            // completed/step-finish=:50, while that very turn was cacheRead=0,
            // input=101838, a full-price COLD read). time.created never restamps.
            //
            // Multi-round-trip turns stay correct: opencode creates a NEW
            // assistant message (fresh time.created) for EACH provider round-trip
            // (verified — each step-finish carries a distinct messageID), so the
            // newest assistant message's time.created already tracks the most
            // recent provider response, including mid-turn cache refreshes. This
            // is why we no longer need the step-finish arrival stamp at all.
            //
            // CRITICAL: the anchor is derived ONLY from ASSISTANT messages, never
            // user messages. A queued user message (typed + submitted while the
            // session is still busy) stamps a fresh time.created immediately, but
            // it has NOT been sent to the provider — no round-trip, no cache
            // refresh. Anchoring on it would falsely reset the timer to full. The
            // provider only touches the cache when it actually engages the turn,
            // which is exactly when the corresponding AssistantMessage is created.
            if (sessionStatus?.type === "busy") {
              let busyModelId: string | undefined;
              if (messages && messages.length > 0) {
                for (let i = messages.length - 1; i >= 0; i--) {
                  const m = messages[i];
                  if (m.role === "assistant") {
                    busyModelId = m.modelID;
                    break;
                  }
                }
              }
              const busyDurationSec = getCacheDuration(busyModelId);

              // Newest assistant message's time.created (ignore queued user msgs).
              let busyAnchor: number | undefined;
              if (messages && messages.length > 0) {
                for (let i = messages.length - 1; i >= 0; i--) {
                  const m = messages[i];
                  if (m.role !== "assistant") continue;
                  const t = m.time?.created ?? m.time?.completed;
                  if (t) {
                    busyAnchor = t;
                    break;
                  }
                }
              }

              if (busyAnchor === undefined) {
                // No anchor yet (turn began before any provider response and
                // before any message timestamp). Show full hot duration.
                setTimeText(`Cache: HOT (${formatTimeText(busyDurationSec)})`)
                setColor("#EF4444") // Red (HOT)
                setCacheState("busy")
                return
              }

              const busyRemainingMs = busyDurationSec * 1000 - (Date.now() - busyAnchor);
              if (busyRemainingMs <= 0) {
                // Cache expired mid-turn. Surface the truth AND the only action
                // the user can take right now: interrupt, then fork. The session
                // is still running, so a plain "New chat" fork isn't available
                // until the turn is aborted — hence the dedicated "busy-cold"
                // state and Interrupt button (see visibility rules).
                setTimeText("Cache: COLD (BUSY)")
                setColor("#3B82F6") // Blue (COLD)
                setCacheState("busy-cold")
              } else {
                const busyMinutes = Math.floor(busyRemainingMs / 1000 / 60)
                const busySeconds = Math.floor((busyRemainingMs / 1000) % 60)
                const busyFormatted = `${String(busyMinutes).padStart(2, "0")}:${String(busySeconds).padStart(2, "0")}`
                setTimeText(`Cache: HOT (${busyFormatted})`)
                setColor(busyRemainingMs < 60 * 1000 ? "#FBBF24" : "#EF4444") // Yellow <1min, else Red
                setCacheState("busy")
              }
              return
            }

            if (!messages || messages.length === 0) {
              setTimeText("Cache: COLD")
              setColor("#3B82F6") // Blue (COLD)
              setCacheState("cold")
              return
            }

            // Anchor on the newest ASSISTANT message's time.created — the moment
            // the provider started responding (cache window reset). See the busy
            // branch above and remainingCacheSecondsFor() for the full rationale:
            // time.completed is restamped at turn-resolution (delayed by however
            // long an interactive prompt sat open) and would falsely reset the
            // timer to FULL on resolve; time.created never restamps. We also scan
            // ASSISTANT messages only — a trailing user message has no provider
            // round-trip and must not anchor the cache clock.
            let currentModelId: string | undefined;
            let lastTime: number | undefined;
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role !== "assistant") continue;
              if (currentModelId === undefined) currentModelId = msg.modelID;
              const t = msg.time?.created ?? msg.time?.completed;
              if (t) {
                lastTime = t;
                break;
              }
            }
            const totalDurationSec = getCacheDuration(currentModelId);

            if (!lastTime) {
              setTimeText(`Cache: HOT (${formatTimeText(totalDurationSec)})`)
              setColor("#EF4444") // Red (HOT)
              setCacheState("hot")
              return
            }

            const elapsedMs = Date.now() - lastTime
            const remainingMs = totalDurationSec * 1000 - elapsedMs

            if (remainingMs <= 0) {
              setTimeText("Cache: COLD")
              setColor("#3B82F6") // Blue (COLD)
              setCacheState("cold")
            } else {
              const minutes = Math.floor(remainingMs / 1000 / 60)
              const seconds = Math.floor((remainingMs / 1000) % 60)
              const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
              setTimeText(`Cache: HOT (${formattedTime})`)

              // Dynamic color feedback: yellow when under 1 minute (almost cold)
              if (remainingMs < 60 * 1000) {
                setColor("#FBBF24") // Yellow (WARNING - almost cold)
                setCacheState("warning")
              } else {
                setColor("#EF4444") // Red (HOT)
                setCacheState("hot")
              }

              // Arm the trigger when the timer is healthy (above trigger zone)
              if (remainingMs > 15 * 1000) {
                healthySessions.add(session_id);
              }

              // Trigger auto-compaction 15 seconds before cache expires to utilize HOT cache.
              // Only triggers if explicitly opted-in AND we have seen a healthy state this cycle (no stale triggers).
              if (enableAutoPrompt && healthySessions.has(session_id) && remainingMs <= 15 * 1000 && remainingMs > 0 && !triggeredSessions.has(session_id)) {
                triggeredSessions.add(session_id);
                healthySessions.delete(session_id); // Require a new healthy cycle reset before triggering again

                // Snapshot the user-message count BEFORE the auto-prompt lands.
                // The next user message that appears beyond this count is
                // definitionally our auto-prompt and will be ledgered as auto by
                // the user-message branch above (which now runs every tick,
                // including during the busy state that follows this call).
                const userMsgCountAtTrigger = messages.filter(m => m.role === "user").length;
                pendingAutoPromptUserCount.set(session_id, userMsgCountAtTrigger);

                api.ui.toast({
                  variant: "warning",
                  title: "Cache Expiring",
                  message: "Cache expiring in 15s! Automatically generating summary to preserve hot cache.",
                  duration: 5000,
                });

                api.client.session.prompt({
                  sessionID: session_id,
                  parts: [{
                    type: "text",
                    text: "Summarize our progress and next steps. Be brief."
                  }]
                }).then(() => {
                  api.ui.toast({
                    variant: "success",
                    title: "Summary Triggered",
                    message: "Successfully requested auto-summary to preserve prompt cache.",
                    duration: 5000,
                  });
                }).catch((err) => {
                  // Roll back the snapshot if the prompt was rejected outright;
                  // no auto-prompt user message will ever land for this trigger.
                  pendingAutoPromptUserCount.delete(session_id);
                  api.ui.toast({
                    variant: "error",
                    title: "Summary Request Failed",
                    message: String(err?.message || err),
                    duration: 10000,
                  });
                });
              }
            }

            // NOTE: interaction-pending toasts (Question/permission cold-cache
            // warnings) are NOT fired here. The per-slot ticker is suspended
            // while a prompt modal is open — exactly when those toasts matter —
            // so they are driven by the module-level interactionWatcher instead.
          } catch (err) {
            console.error("[Cache-Timer Error]", err);
          }
        }

        // Start the 1s cadence. NOTE: we intentionally do NOT prime the first
        // frame with a synchronous runTick() here. Doing so ran the full tick
        // body (messages scan + question fetch + debug logging) on the slot
        // render/mount path, which froze sessions on remount. The harmless
        // one-frame "HOT (max)" flash before the first interval tick is the
        // accepted trade-off; reintroduce priming only via a deferred
        // (queueMicrotask/setTimeout 0) call if the flash needs fixing.
        const interval = setInterval(runTick, 1000)

        onCleanup(() => {
          clearInterval(interval)
          stopSpinner()
          // NOTE: we intentionally do NOT clear warningToastFiredSessions /
          // coldToastFiredSessions here. The slot REMOUNTS when a Question modal
          // closes (e.g. on reply, when the assistant's turn continues), and the
          // old instance's onCleanup runs during that remount. Deleting the
          // fired-set entries here used to RACE the global interactionWatcher's
          // re-arm loop and win — stealing the resolve signal so the sweeper toast
          // never fired and the cold/warning toast lingered after answering (it
          // worked on reject only because the turn ended and the watcher won the
          // race). The watcher is now the SOLE owner of these sets: it clears them
          // (and fires the sweeper) exactly when the interaction resolves. They
          // are keyed per-session and only ever set while a prompt is pending, so
          // leaving them for the watcher to reap is correct and race-free.
        })

        // Visibility rules (derived from cacheState + hasMessages).
        //
        // The plugin's thesis, expressed as UI: "Hot cache → keep going.
        // Cold cache → fork." On a hot cache, continuing is unambiguously
        // cheaper than forking because the 90% hot-read discount eats the
        // bloat. On a cold cache, forking is cheaper because both branches
        // owe full-price tokens for *something*, and the fresh branch is
        // smaller. Each state therefore exposes exactly one button — the
        // recommended action — and hides the other.
        //
        //   Refresh button:
        //     - HIDDEN on COLD and BUSY-COLD: clicking it would just pay full
        //       cold-cache tax for nothing (the original v1.1.0 "trap").
        //     - Shown on HOT, WARNING, and BUSY: queueing a refresh during a
        //       busy turn is fine — it just lands after the current turn
        //       resolves, and hiding the button mid-stream would only add UI
        //       noise. The in-flight debounce still prevents double-clicks.
        //
        //   New chat button:
        //     - HIDDEN when there are no messages: nothing to seed from.
        //     - HIDDEN on HOT, WARNING, and BUSY: while the cache is hot,
        //       forking is *more expensive* than continuing (you pay full
        //       price to rebuild context in the new session, vs the 10% hot
        //       rate to keep going). WARNING is just HOT with less time left
        //       — the cost math is identical, only the color changes. Users
        //       who explicitly want a clean fork on hot can still type /new.
        //     - Shown on COLD (idle): this is the *primary* action when the
        //       cache has expired — fork instead of paying the cold-write tax.
        //
        //   Interrupt button:
        //     - Shown ONLY on BUSY-COLD: the turn is still running but the
        //       cache has already expired. A plain fork isn't possible yet
        //       (session is busy), so we offer Interrupt-then-fork. Doing
        //       nothing means the long task will resume against a cold cache
        //       and pay the full tax — which the user may still choose, so the
        //       button is an option, not a forced action.
        const showRefresh = () =>
          cacheState() !== "cold" && cacheState() !== "busy-cold"
        const showNewChat = () => hasMessages() && cacheState() === "cold"
        const showInterrupt = () => cacheState() === "busy-cold"

        return (
          // flexDirection="row" lays the buttons and timer text on a single
          // line. Without it OpenTUI defaults to column (vertical) stacking,
          // which is what produced the "extra line" in v1.1.0.
          <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={1}>
            {showInterrupt() && (
              <box
                onMouseUp={handleInterruptClick}
                backgroundColor={interruptInFlight() ? "#1E3A5F" : "#2563EB"}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={interruptInFlight() ? "#93C5FD" : "#F3F4F6"}>
                  {interruptInFlight() ? "Stopping..." : "✨ Stop & fork"}
                </text>
              </box>
            )}
            {showNewChat() && (
              <box
                onMouseUp={handleNewChatClick}
                backgroundColor={newChatInFlight() ? "#1E3A5F" : "#2563EB"}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={newChatInFlight() ? "#93C5FD" : "#F3F4F6"}>
                  {newChatInFlight()
                    ? `Starting... ${SPINNER_FRAMES[spinnerFrame()]}`
                    : "✨ New chat"}
                </text>
              </box>
            )}
            {showRefresh() && (
              <box
                onMouseUp={handleRefreshClick}
                backgroundColor={refreshInFlight() ? "#374151" : "#4B5563"}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={refreshInFlight() ? "#9CA3AF" : "#F3F4F6"}>
                  {refreshInFlight() ? "Sending..." : "↻ Refresh"}
                </text>
              </box>
            )}
            <text fg={color()}><b>{timeText()}</b></text>
          </box>
        )
      }
    }
  })
  } catch (e: any) {
    debugLog(`api.slots.register THREW: ${e?.message || e}`);
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "cache-timer",
  tui,
}

export default plugin
