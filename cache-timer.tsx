/** @jsxImportSource @opentui/solid */
import { type JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { appendFileSync, readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Displayed in the load toast to verify which build is running. Keep in sync
// with package.json on release.
const CACHE_TIMER_VERSION = "1.2.0"

// File-based debug logger. Never throws; writes silently to /tmp.
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

// Read config from a sidecar JSON file. opencode.json's inline plugin-options
// tuple isn't forwarded to TUI plugins (1.15.x), so we read our own sidecar.
// Project (./.opencode) wins over global (~/.config/opencode) per field.
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

// Default cache durations (seconds) keyed by provider family. getCacheDuration()
// substring-matches the model id, so "claude" covers all claude-* variants.
let cacheDurations: Record<string, number> = {
  "claude": 300,
  "gemini": 300,
  "gpt": 300,
};
let defaultDuration = 300; // Fallback to 5 minutes (300s)

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

// Slot-independent remaining-seconds calc for the global interaction watcher
// (the per-slot ticker is suspended while a prompt modal is open — exactly when
// the toasts matter). Same time.created anchor as the ticker.
function remainingCacheSecondsFor(api: TuiPluginApi, sessionID: string): number | undefined {
  let messages: ReadonlyArray<any> | undefined;
  try {
    messages = api.state.session.messages(sessionID);
  } catch {
    return undefined;
  }

  // Anchor on the newest assistant message's time.created (model id from same).
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

// Build a minimal seed prompt for a fresh chat: last user message, last
// assistant reply, and up to 5 recently-read files. Returns null when there's
// no coherent last exchange (caller then hides the New chat button).
function buildSeedPrompt(
  api: TuiPluginApi,
  sourceSessionID: string,
): string | null {
  const messages = api.state.session.messages(sourceSessionID);
  if (!messages || messages.length === 0) return null;

  // Scan from the tail so an in-flight reply is preferred over an older one.
  let lastUserMsg: typeof messages[number] | undefined;
  let lastAssistantMsg: typeof messages[number] | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!lastAssistantMsg && m.role === "assistant") lastAssistantMsg = m;
    if (!lastUserMsg && m.role === "user") lastUserMsg = m;
    if (lastUserMsg && lastAssistantMsg) break;
  }
  if (!lastUserMsg || !lastAssistantMsg) return null;

  // Message text lives in TextPart records keyed by messageID; join them all
  // (skip synthetic/ignored parts).
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

  // Most recently read file paths, newest-first, deduped, capped at 5.
  const recentReadFiles: string[] = [];
  const seenPaths = new Set<string>();
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const parts = api.state.part(messages[i].id);
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part.type !== "tool") continue;
      if (part.tool !== "read") continue;
      // Tool input key varies by opencode version: filePath (current) or path.
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

function formatTimeText(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const calculatedSeconds = Math.floor(totalSeconds % 60)
  return `${String(minutes).padStart(2, "0")}:${String(calculatedSeconds).padStart(2, "0")}`
}

// Semantic state the ticker writes each second; UI text/color/button visibility
// all read from it. "busy-cold" = turn running but cache already expired (COLD
// wins over busy; only action is Interrupt-then-fork).
type CacheState = "hot" | "warning" | "cold" | "busy" | "busy-cold";

// Module-level session-keyed states to ensure absolute isolation across multiple sessions
const triggeredSessions = new Set<string>();
const healthySessions = new Set<string>();
const lastUserMsgIds = new Map<string, string>();
const autoPromptIds = new Set<string>(); // Immutable ledger of all generated auto-prompt message IDs

// Per-episode toast dedupe (session IDs that already fired the toast). Cleared
// when the prompt resolves so the next episode re-arms. Two sets because warning
// and cold are distinct events: a session can fire both within one episode.
const warningToastFiredSessions = new Set<string>();
const coldToastFiredSessions = new Set<string>();

// Open interactive prompts (Question + permission), sessionID -> set of request
// IDs. Populated from the event stream, not state pollers (question()/permission()
// proved unreliable). Keyed by ID so overlapping prompts ref-count correctly.
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

// User-message count snapshot taken when an auto-summary fires. The next user
// message beyond this count is our auto-prompt, ledgered as auto — preventing
// the re-arm/infinite-loop race when busy ticks skip ledgering.
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
    // Question lifecycle: question.asked -> question.replied|rejected.
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

  // Global interaction-toast watcher (module-level, not per-slot). The slot
  // ticker is suspended while a prompt modal is open — exactly when these toasts
  // matter — so this independent interval drives them for the TUI lifetime,
  // toasting on WARNING (<60s) and COLD (<=0) for any session with a pending
  // interaction.
  try {
    const interactionWatcher = setInterval(() => {
      try {
        // Re-arm dedupes for resolved sessions and sweep their lingering toast.
        // The 24h cold toast won't self-clear, so we emit a blank 1ms "sweeper"
        // toast — opencode clears all toasts when a new one is emitted. Blank,
        // not "cache refreshed", which would lie on cancel/still-cold.
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
          // One sweeper clears all toasts, regardless of how many resolved.
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
                // 24h so it survives a long break; swept on resolve (see above).
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
    // Never cleaned up: lives for the TUI process lifetime (no teardown hook here).
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
        // Semantic cache state; ticker writes, buttons read for visibility.
        const [cacheState, setCacheState] = createSignal<CacheState>("hot")
        // Whether the source session has anything to seed a New chat from.
        const [hasMessages, setHasMessages] = createSignal(messagesOnMount && messagesOnMount.length > 0)

        // Per-button in-flight flags debounce double-clicks (async APIs).
        const [refreshInFlight, setRefreshInFlight] = createSignal(false)
        const [newChatInFlight, setNewChatInFlight] = createSignal(false)
        const [interruptInFlight, setInterruptInFlight] = createSignal(false)

        // Spinner for the "Starting..." label: cold-cache TTFT can be 30-60s, so
        // motion confirms the click registered. 100ms frames on its own interval.
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

        // Fork a fresh session seeded from the last exchange, avoiding the
        // cold-cache tax of reviving a bloated history.
        // Flow: build seed -> create session -> navigate -> fire prompt.
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

            // Inherit the source model (carried on the most recent user message).
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

            // Navigate FIRST, then fire the prompt fire-and-forget: session.prompt
            // only resolves when the turn completes, which hangs forever if the
            // new session's first reply uses an interactive tool (v1.1.0 bug).
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
            // Clear once create+navigate finish; we don't wait for the turn.
            setNewChatInFlight(false)
            stopSpinner()
          }
        }

        // Interrupt-and-fork (busy-cold only): abort the running turn, then reuse
        // the New-chat flow to fork from the interrupted output.
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
            await handleNewChatClick()
          } finally {
            setInterruptInFlight(false)
          }
        }

        // Per-second ticker: recomputes cache state and updates the signals.
        const runTick = () => {
          if (!session_id) return

          try {
            const sessionStatus = api.state.session.status(session_id);
            const messages = api.state.session.messages(session_id);

            // Ledger user messages every tick (incl. busy): skipping during busy
            // lets the auto-prompt look human later and re-fire in a loop.
            if (messages && messages.length > 0) {
              const userMessages = messages.filter(m => m.role === "user");
              if (userMessages.length > 0) {
                const lastUserMsg = userMessages[userMessages.length - 1];
                const prevUserMsgId = lastUserMsgIds.get(session_id);
                if (lastUserMsg.id && prevUserMsgId !== lastUserMsg.id) {
                  lastUserMsgIds.set(session_id, lastUserMsg.id);

                  // Ours iff we have a snapshot AND the count exceeds it.
                  const expectedAutoCount = pendingAutoPromptUserCount.get(session_id);
                  const isAutoPrompt =
                    expectedAutoCount !== undefined &&
                    userMessages.length > expectedAutoCount;

                  if (isAutoPrompt) {
                    autoPromptIds.add(lastUserMsg.id);
                    pendingAutoPromptUserCount.delete(session_id); // consume snapshot
                  } else if (prevUserMsgId && !autoPromptIds.has(lastUserMsg.id)) {
                    triggeredSessions.delete(session_id); // human prompt re-arms trigger
                  }
                }
              }
            }

            setHasMessages(!!messages && messages.length > 0)

            // Keep the countdown live while busy: the cache clock ticks during
            // long local tool calls even though the provider went silent.
            // Cache state is the source of truth — never let "busy" mask COLD.
            // Anchor on the newest ASSISTANT message's time.created: it stamps
            // when the provider starts responding and never restamps, unlike
            // time.completed/step-finish (restamped at turn resolution, which
            // for interactive prompts falsely reset the timer to FULL). Assistant
            // only — a queued user message has no provider round-trip.
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
                // No anchor yet (no provider response): show full hot duration.
                setTimeText(`Cache: HOT (${formatTimeText(busyDurationSec)})`)
                setColor("#EF4444") // Red (HOT)
                setCacheState("busy")
                return
              }

              const busyRemainingMs = busyDurationSec * 1000 - (Date.now() - busyAnchor);
              if (busyRemainingMs <= 0) {
                // Cache expired mid-turn: show busy-cold (only action is Interrupt).
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

            // Anchor on newest assistant message's time.created (see busy branch).
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

              // Yellow under 1 minute (almost cold).
              if (remainingMs < 60 * 1000) {
                setColor("#FBBF24") // Yellow (WARNING - almost cold)
                setCacheState("warning")
              } else {
                setColor("#EF4444") // Red (HOT)
                setCacheState("hot")
              }

              // Arm the trigger only after a healthy cycle (no stale triggers).
              if (remainingMs > 15 * 1000) {
                healthySessions.add(session_id);
              }

              // Opt-in auto-summary 15s before expiry, while the cache is still hot.
              if (enableAutoPrompt && healthySessions.has(session_id) && remainingMs <= 15 * 1000 && remainingMs > 0 && !triggeredSessions.has(session_id)) {
                triggeredSessions.add(session_id);
                healthySessions.delete(session_id); // require a fresh healthy cycle before re-firing

                // Snapshot user-msg count so the ledger can tag the auto-prompt.
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
                  pendingAutoPromptUserCount.delete(session_id); // rejected: no auto-prompt will land
                  api.ui.toast({
                    variant: "error",
                    title: "Summary Request Failed",
                    message: String(err?.message || err),
                    duration: 10000,
                  });
                });
              }
            }

            // Interaction-pending toasts are fired by interactionWatcher, not
            // here — this ticker is suspended while a prompt modal is open.
          } catch (err) {
            console.error("[Cache-Timer Error]", err);
          }
        }

        // No synchronous prime: running runTick() on the mount path froze
        // sessions on remount. Accept a one-frame "HOT (max)" flash instead.
        const interval = setInterval(runTick, 1000)

        onCleanup(() => {
          clearInterval(interval)
          stopSpinner()
          // Don't clear the toast fired-sets here. The slot remounts on reply,
          // so clearing would race the watcher and steal the resolve signal.
          // The watcher is the sole owner; it reaps them when the prompt resolves.
        })

        // Visibility thesis: hot cache → keep going (Refresh), cold cache → fork
        // (New chat / Interrupt). Each state shows exactly the recommended action.
        // Refresh hidden on COLD/BUSY-COLD (would pay cold tax for nothing).
        // New chat shown only on COLD with messages. Interrupt only on BUSY-COLD.
        const showRefresh = () =>
          cacheState() !== "cold" && cacheState() !== "busy-cold"
        const showNewChat = () => hasMessages() && cacheState() === "cold"
        const showInterrupt = () => cacheState() === "busy-cold"

        return (
          // row layout keeps buttons + timer on one line (OpenTUI defaults to column).
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
