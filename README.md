# opencode-cache-timer ⚡🕒

An elegant, zero-overhead, pre-emptive **Prompt Cache-Saving extension** for [OpenCode](https://opencode.ai). It monitors your session's inactivity countdown in real-time and proactively triggers a lightweight summary query **exactly 15 seconds before the cache expires**, keeping your hot prompt cache alive or summarizing it so you can cleanly transition to a fresh session.

---

## 💡 The Problem: The Massive "Cold Cache" Write Tax

When working on complex, enterprise-grade projects with large codebases, your session context can easily grow to **500k+ input tokens**.

Under Anthropic's official pricing models for **Claude Opus 4.7**:
*   **Base Input Rate**: $5.00 / Million Tokens
*   **Prompt Cache Write Fee** (to write new context): **$6.25 / Million Tokens** (1.25x base)
*   **Prompt Cache Read Fee** (to read hot context): **$0.50 / Million Tokens** (90% discount)

### The Cold Context Penalty (500k Tokens):
If you walk away from a **500,000 token session** for more than 5 minutes, your prompt cache goes **COLD**.
*   **Continuing the Cold Session:** Your very next query will cost you **$3.125** just to write that cold context back into memory, plus several seconds of startup latency.
*   **Subsequent Queries (While Hot):** Read charges drop back down to only **$0.25** per turn.

---

## ⚡ The Solution: Pre-emptive Cache Compaction

`opencode-cache-timer` adds an active countdown indicator directly on the right side of your session prompt:
*   🔥 **Cache: HOT (05:00)** (Red): Active, healthy prompt cache.
*   ⚠️ **Cache: HOT (00:45)** (Yellow): Less than 1 minute remaining before expiration.
*   ❄️ **Cache: COLD** (Blue): Cache expired or model changed.

---

## 🔒 Privacy-First: Opt-in Auto-Prompting
By default, the active visual countdown is enabled, but **the automated background prompt is disabled**. If you want the extension to automatically request summaries and keep your cache hot while you are away, you must explicitly **opt-in** in your configuration.

### 🧠 Intelligent Automation (When Opted-In):
If you enable auto-prompting and remain inactive for **4 minutes and 45 seconds** (exactly 15s before the cache shuts down), the plugin automatically:
1.  Displays a warning toast in the UI.
2.  Triggers a highly optimized, lightweight background prompt:
    > *"Summarize our progress and next steps. Be brief."*
3.  **The Economics:** Because the cache is still **HOT** when this request is sent, Claude reads your massive 500k-token prompt at the ultra-cheap **HOT rate ($0.25 instead of $3.125)**.
4.  It prints a highly concise, cost-effective summary directly in your session logs.
5.  **The Net Savings:** You can copy this summary, close the bloated 500k session, open a fresh session, paste it, and keep working with a clean, lightweight context. 

Instead of paying the **$3.125** cold write fee when you return, you paid a tiny **$0.25** hot-read fee to summarize your progress, resulting in a **net savings of $2.87 per timeout occurrence!**

---

## 🛡️ Built-in Concurrency & Self-Trigger Guardrails
Unlike naive intervals, this plugin is engineered specifically for terminal UI environments:
*   **Single-Interval Architecture**: Runs exactly *one* global daemon loop in the plugin module scope, completely preventing duplicate triggers or timing race-conditions if multiple slot panes re-render.
*   **Human-Only Reset Tracking**: Generates unique trigger timestamps and ignores any incoming message within 10s of a trigger event. The trigger state **only re-arms when a real human user enters a manual prompt**, successfully preventing the auto-prompt from infinitely resetting its own trigger!

---

## 🚀 Quick Start / Installation

You can add this plugin globally to your personal `opencode.json` configuration.

### 1. Register the Plugin
Open your global opencode configuration file (usually located at `~/.config/opencode/opencode.json`) and add the folder path of the extension to the `"plugin"` array. 

By default, the visual timer is active. To enable the optional cache-saving auto-prompts, pass `"enableAutoPrompt": true` in the configuration options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///Users/YOUR_USERNAME/github/opencode-cache-timer", {
      "enableAutoPrompt": true
    }]
  ]
}
```

*Replace `YOUR_USERNAME` with your actual system username. If installing from npm (once published), use `"opencode-cache-timer"` instead of the `file:///` path.*

### 2. Restart OpenCode
Quit your active terminal session and start a fresh instance of `opencode` to load the plugin.

---

## 🛠️ Building from Source

If you modify the source `cache-timer.tsx` component, you can transpile the TypeScript Solid-JSX code into portable TUI-compliant JavaScript by running:

```bash
# Install development compilers
npm install

# Recompile cache-timer.tsx -> tui.js
npm run build
```
