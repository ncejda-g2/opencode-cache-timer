<div align="center">
  <h1 align="center">opencode-cache-timer ⚡🕒</h1>

  <p align="center">
    <strong>Live prompt-cache countdown and pre-emptive cache-saving for <a href="https://opencode.ai">OpenCode</a></strong>
  </p>

  <p align="center">
    <a href="https://www.npmjs.com/package/opencode-cache-timer">
      <img src="https://img.shields.io/npm/v/opencode-cache-timer?color=9b59b6" alt="npm" />
    </a>
    <a href="./CHANGELOG.md">
      <img src="https://img.shields.io/badge/changelog-Latest%20Changes-blue" alt="Changelog" />
    </a>
    <a href="./LICENSE">
      <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
    </a>
  </p>

  <p align="center">
    <a href="#what-is-it">What is it?</a> •
    <a href="#-quick-start">Quick Start</a> •
    <a href="#configuration">Configuration</a> •
    <a href="./CHANGELOG.md">Changelog</a>
  </p>
</div>

---

## What is it?

A TUI plugin that shows a live countdown to your prompt-cache expiry in the OpenCode session bar, and — opt-in — fires a tiny "summarize progress" prompt 15 seconds before the cache goes cold so the cache never actually expires while you're stepping away.

The countdown indicator on the right side of your prompt:

- 🔥 **Cache: HOT (05:00)** — healthy, time remaining
- ⚠️ **Cache: HOT (00:45)** — under one minute, about to expire
- ❄️ **Cache: COLD** — expired or model changed

## Features

- 🕒 **Live countdown** in `session_prompt_right`, per-model duration
- 💸 **Pre-emptive auto-summary** (opt-in) — turns a $3.13 cold-write back into a $0.25 hot-read
- 🧩 **Per-family durations** — single `claude` / `gemini` / `gpt` entries via substring matching
- 📄 **Sidecar config** — `~/.config/opencode/cache-timer.json` (global) + `./.opencode/cache-timer.json` (project)
- 🛡️ **Race-safe** — single global tick loop, user-message-count ledger prevents auto-prompt self-retriggering

## 🚀 Quick Start

### 1. Install

```bash
# Symlink this repo into opencode's global plugin dir
ln -s /path/to/opencode-cache-timer ~/.config/opencode/plugins/cache-timer
```

Or copy the runtime files:

```bash
mkdir -p ~/.config/opencode/plugins/cache-timer
cp tui.js index.js package.json ~/.config/opencode/plugins/cache-timer/
```

### 2. (optional) Enable auto-prompting

Create `~/.config/opencode/cache-timer.json`:

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

`durations` is keyed by provider family and substring-matched against the model id, so `"claude": 300` covers `claude-opus-4-7`, `claude-haiku-4-5`, `claude-3-5-sonnet`, etc. Per-project overrides live at `./.opencode/cache-timer.json` and win field-by-field over the global file.

### 3. Restart OpenCode

Quit and relaunch — you should see a small green "Cache Timer loaded" toast on startup.

## Configuration

| Field              | Type    | Default                                       | Notes                                              |
| ------------------ | ------- | --------------------------------------------- | -------------------------------------------------- |
| `enableAutoPrompt` | boolean | `false`                                       | Send the auto-summary prompt 15s before expiry     |
| `durations`        | object  | `{ claude: 300, gemini: 300, gpt: 300 }`      | Seconds, keyed by provider family (substring)      |
| `defaultDuration`  | number  | `300`                                         | Fallback when the model doesn't match any family   |

<details>
<summary><b>Why a sidecar file instead of <code>opencode.json</code>?</b></summary>

Opencode's `opencode.json` validates against a strict JSON schema with `additionalProperties: false` at the top level, so an inline `cacheTimer: { ... }` block would prevent opencode from starting. The documented `["file://path", { ...options }]` plugin-tuple form does not forward options to TUI plugins in released opencode (verified against v1.15.x; an empirical survey of nine ecosystem plugins found that zero of them use that mechanism). Sidecar JSON files are the de-facto idiomatic pattern, used by `opencode-dcp`, `opencode-vibeguard`, `opencode-sentry-monitor`, and `opencode-notificator`.

</details>

<details>
<summary><b>Pricing math (why this exists)</b></summary>

Claude Opus 4.7 pricing:

| Operation                        | Rate (per Mtoken) |
| -------------------------------- | ----------------- |
| Base input                       | $5.00             |
| Prompt cache **write** (cold)    | $6.25             |
| Prompt cache **read** (hot)      | $0.50             |

A 500k-token session that goes cold costs **$3.13** just to warm back up. Sending the tiny auto-summary prompt while still hot costs **$0.25** to read the same context. The plugin trades the $3.13 cold-write for a $0.25 hot-read, so **net savings ≈ $2.87 per timeout** for any session you'd otherwise resume.

</details>

## 🛠️ Building from Source

```bash
npm install
npm run build   # compiles cache-timer.tsx -> tui.js
```

---

<div align="center">
  <p>
    <a href="https://github.com/ncejda-g2/opencode-cache-timer/issues">Report Bug</a> •
    <a href="https://github.com/ncejda-g2/opencode-cache-timer/issues">Request Feature</a>
  </p>
</div>
