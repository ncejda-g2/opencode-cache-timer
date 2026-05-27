/** @jsxImportSource @opentui/solid */
import { type JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { appendFileSync, readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Single source of truth for the displayed version. Keep this in sync with
// package.json on release; surfacing it in the load toast is a cheap way to
// verify which build is actually running (especially useful when iterating
// against the cached npm install under ~/.cache/opencode/packages).
const CACHE_TIMER_VERSION = "1.1.0"

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

// Helper to format remaining seconds as MM:SS
function formatTimeText(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const calculatedSeconds = Math.floor(totalSeconds % 60)
  return `${String(minutes).padStart(2, "0")}:${String(calculatedSeconds).padStart(2, "0")}`
}

// Module-level session-keyed states to ensure absolute isolation across multiple sessions
const triggeredSessions = new Set<string>();
const healthySessions = new Set<string>();
const lastUserMsgIds = new Map<string, string>();
const autoPromptIds = new Set<string>(); // Immutable ledger of all generated auto-prompt message IDs

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
    });
  } catch (e: any) {
    debugLog(`api.ui.toast THREW: ${e?.message || e}`);
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

        // Refresh button state.
        // - hovered: drives border color change as hover affordance
        // - inFlight: guards against rapid double-clicks spamming the session
        //   (the prompt API is async; clicking again before it resolves would
        //   queue a second user message and undo our cache-preservation goal)
        const [refreshHovered, setRefreshHovered] = createSignal(false)
        const [refreshInFlight, setRefreshInFlight] = createSignal(false)

        const handleRefreshClick = () => {
          if (!session_id) return
          if (refreshInFlight()) return // debounce: ignore if already sending
          setRefreshInFlight(true)

          api.client.session.prompt({
            sessionID: session_id,
            parts: [{
              type: "text",
              text: "say 'refresh'"
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

        // Local interval ticker that directly updates this component's reactive signals.
        // This guarantees the UI text updates flawlessly and never freezes.
        const interval = setInterval(() => {
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

            // If the session is actively processing or streaming, freeze visual countdown and display "Busy"
            if (sessionStatus?.type === "busy") {
              setTimeText("Cache: HOT (Busy)")
              setColor("#EF4444") // Red (HOT)
              return
            }

            if (!messages || messages.length === 0) {
              setTimeText("Cache: COLD")
              setColor("#3B82F6") // Blue (COLD)
              return
            }

            const lastMsg = messages[messages.length - 1]
            const currentModelId = lastMsg.role === "user" ? lastMsg.model?.modelID : lastMsg.modelID;
            const totalDurationSec = getCacheDuration(currentModelId);

            // Robustly resolve the most recent valid timestamp in the session history (handles active streaming)
            let lastTime: number | undefined;
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              const t = msg.time?.completed ?? msg.time?.created;
              if (t) {
                lastTime = t;
                break;
              }
            }

            if (!lastTime) {
              setTimeText(`Cache: HOT (${formatTimeText(totalDurationSec)})`)
              setColor("#EF4444") // Red (HOT)
              return
            }

            const elapsedMs = Date.now() - lastTime
            const remainingMs = totalDurationSec * 1000 - elapsedMs

            if (remainingMs <= 0) {
              setTimeText("Cache: COLD")
              setColor("#3B82F6") // Blue (COLD)
            } else {
              const minutes = Math.floor(remainingMs / 1000 / 60)
              const seconds = Math.floor((remainingMs / 1000) % 60)
              const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
              setTimeText(`Cache: HOT (${formattedTime})`)
              
              // Dynamic color feedback: yellow when under 1 minute (almost cold)
              if (remainingMs < 60 * 1000) {
                setColor("#FBBF24") // Yellow (WARNING - almost cold)
              } else {
                setColor("#EF4444") // Red (HOT)
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
          } catch (err) {
            console.error("[Cache-Timer Error]", err);
          }
        }, 1000)

        onCleanup(() => {
          clearInterval(interval)
        })

        return (
          <box paddingLeft={1} paddingRight={1}>
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
            <text fg={color()}><b> {timeText()}</b></text>
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
