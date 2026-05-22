/** @jsxImportSource @opentui/solid */
import { type JSX } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// Default model cache durations in seconds (reflects standard provider specifications)
let cacheDurations: Record<string, number> = {
  "claude-3-5": 300,
  "claude-3-7": 300,
  "claude-opus": 300,
  "claude-haiku": 300,
  "claude-4": 300,
  "gemini": 300,
  "gpt-4": 300,
  "gpt-5": 300,
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
let isTriggeringAutoSummary = false; // Transaction-style lock during API execution

const tui: TuiPlugin = async (api, options, meta) => {
  api.ui.toast({
    variant: "success",
    title: "Cache Timer",
    message: "Global Timer Plugin loaded!",
    duration: 3000,
  })

  // Safe defaults: Auto-prompt is disabled by default for privacy & user control
  let enableAutoPrompt = false;

  // Merge any user-defined configuration from opencode.json (if present)
  if (options) {
    if (options.defaultDuration && typeof options.defaultDuration === "number") {
      defaultDuration = options.defaultDuration;
    }
    if (options.durations && typeof options.durations === "object") {
      cacheDurations = { ...cacheDurations, ...options.durations };
    }
    if (options.enableAutoPrompt && typeof options.enableAutoPrompt === "boolean") {
      enableAutoPrompt = options.enableAutoPrompt;
    }
  }

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

        // Local interval ticker that directly updates this component's reactive signals.
        // This guarantees the UI text updates flawlessly and never freezes.
        const interval = setInterval(() => {
          if (!session_id) return

          try {
            const sessionStatus = api.state.session.status(session_id);

            // If the session is actively processing or streaming, freeze visual countdown and display "Busy"
            if (sessionStatus?.type === "busy") {
              setTimeText("Cache: HOT (Busy)")
              setColor("#EF4444") // Red (HOT)
              return
            }

            const messages = api.state.session.messages(session_id);

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

              // Trigger auto-compaction 15 seconds before cache expires to utilize HOT cache
              // Only triggers if explicitly opted-in AND we have seen a healthy state this cycle (no stale triggers)
              if (enableAutoPrompt && healthySessions.has(session_id) && remainingMs <= 15 * 1000 && remainingMs > 0 && !triggeredSessions.has(session_id)) {
                triggeredSessions.add(session_id);
                healthySessions.delete(session_id); // Require a new healthy cycle reset before triggering again
                isTriggeringAutoSummary = true;

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
                  api.ui.toast({
                    variant: "error",
                    title: "Summary Request Failed",
                    message: String(err?.message || err),
                    duration: 10000,
                  });
                }).finally(() => {
                  isTriggeringAutoSummary = false;
                });
              }
            }

            // Check for user messages to safely re-arm the trigger state
            const userMessages = messages.filter(m => m.role === "user");
            if (userMessages.length > 0) {
              const lastUserMsg = userMessages[userMessages.length - 1];
              if (lastUserMsg.id && lastUserMsgIds.get(session_id) !== lastUserMsg.id) {
                const oldId = lastUserMsgIds.get(session_id);
                lastUserMsgIds.set(session_id, lastUserMsg.id);
                
                // If we are actively triggering a summary, ledger this new user message ID as automated
                if (isTriggeringAutoSummary) {
                  autoPromptIds.add(lastUserMsg.id);
                }

                // Only re-arm the trigger if this user message was sent by the human (NOT our auto-prompt)
                if (oldId && !isTriggeringAutoSummary && !autoPromptIds.has(lastUserMsg.id)) {
                  triggeredSessions.delete(session_id);
                }
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
            <text fg={color()}><b>{timeText()}</b></text>
          </box>
        )
      }
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "cache-timer",
  tui,
}

export default plugin
