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

### 1. Install the Plugin
Drop (or symlink) this plugin's compiled output into opencode's global plugin directory. Opencode auto-loads everything in this folder at startup:

```bash
# Clone or copy this repo somewhere, then symlink:
ln -s /path/to/opencode-cache-timer ~/.config/opencode/plugins/cache-timer
```

Or copy just the runtime files:

```bash
mkdir -p ~/.config/opencode/plugins/cache-timer
cp tui.js index.js package.json ~/.config/opencode/plugins/cache-timer/
```

### 2. Configure (optional)
The visual timer is active by default. To enable the optional cache-saving auto-prompt or tune per-family cache durations, create a sidecar config file at `~/.config/opencode/cache-timer.json`:

```json
{
  "enableAutoPrompt": true,
  "durations": {
    "claude": 300,
    "gemini": 300,
    "gpt": 300
  }
}
```

The `durations` map is keyed by **provider family** (substring-matched against the model id, case-insensitive). So `"claude": 300` covers `claude-opus-4-7`, `claude-haiku-4-5`, `claude-3-5-sonnet`, and any other `claude-*` variant.

Per-project overrides can be placed at `./.opencode/cache-timer.json`; project values win over global on a per-field basis.

> **Why a sidecar file instead of `opencode.json`?** Opencode's `opencode.json` validates against a strict JSON schema (`additionalProperties: false` at the top level) and rejects unknown keys, so an inline `cacheTimer: { ... }` block would prevent opencode from starting. The `["file://path", { ...options }]` tuple form is also documented but **does not currently forward options to TUI plugins** in released opencode (verified empirically against v1.15.x; a survey of nine real ecosystem plugins found that **zero** of them use that mechanism). Sidecar JSON files are the de-facto idiomatic pattern, used by `opencode-dcp`, `opencode-vibeguard`, `opencode-sentry-monitor`, and `opencode-notificator`.

### 3. Restart OpenCode
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

---

## 🚀 Release Process (maintainers)

Releases are fully automated via GitHub Actions (`.github/workflows/publish.yml`). The workflow watches `package.json` on `main`: when its `version` field changes, the workflow tags the commit, creates a GitHub Release, rebuilds `tui.js` from source, and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing.

To cut a release:

1. Move the relevant `CHANGELOG.md` entries from `[Unreleased]` to a new dated version heading (e.g. `## [1.1.0] - 2026-05-26`).
2. Bump `version` in `package.json`.
3. Commit on `main`. The workflow runs automatically.

For recovery (re-running publish for an already-tagged version), use the **Run workflow** button in the Actions tab and pass the version (without leading `v`).

**One-time setup on npm:** configure this package's [Trusted Publisher](https://docs.npmjs.com/trusted-publishers) on npmjs.com to accept OIDC tokens from `ncejda-g2/opencode-cache-timer` → workflow `publish.yml` → environment `npm-publish`. Also create a GitHub Environment named `npm-publish` on the repo (Settings → Environments) — no secrets needed inside it.
