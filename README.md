# DisClawd 🦅

> **An OpenClaw alternative on Discord. Keep using your Claude Code subscription.**

Turn every Discord channel into an independent Claude Code agent. Each channel = one project, one context, one parallel session — all driven by your existing Claude Code CLI (no API costs beyond your subscription).

**Built with:** Bun + Discord.js + SQLite + Claude Code CLI

---

## Why DisClawd?

[OpenClaw](https://github.com/anomalyco/opencode) and similar tools require their own runtime, plugins, and a new mental model. DisClawd takes a different approach:

- **Use your Claude Code subscription as-is** — DisClawd just spawns `claude -p` processes. No extra API keys, no token billing surprises.
- **Discord is the UI** — no web app to host, no Electron client. You already have Discord on every device.
- **Channels are agents** — each channel has its own working directory, system prompt, model, and persistent session. Switch projects by switching channels.
- **Mobile-first by accident** — because Discord works everywhere, your Claude Code stack does too.
- **Live streaming** — see Claude work in real time, with todo embeds and tool activity tracking.

```
You (Discord on phone, laptop, anywhere)
  │
  ├── #refonte-site ──→ Claude session (Next.js project, /workspace/site)
  ├── #pipeline ──────→ Claude session (Lead gen, /workspace/pipeline)
  ├── #système ───────→ Claude session (VPS admin, /home/user)
  ├── #webcam ────────→ Claude session (Camera project, /home/user)
  └── #général ───────→ Claude session (HQ — sees all activity, routes commands)
```

---

## Features

### Core
- 🧵 **Per-channel sessions** with `--resume` for true context persistence
- 🔀 **10 concurrent sessions** across channels (configurable)
- 📥 **Message queuing** when a channel is busy (max 5 per channel)
- 🧠 **Adaptive memory compaction** — summarize long conversations and reset, threshold tunable per channel
- 📊 **Activity digest** for the `#général` channel — cross-channel awareness
- 🚦 **Command routing** — from `#général`: `@#refonte fix the WebP images`

### Visual control
- 💬 **Rich embeds** for live status, todos, and tool activity
- 🎛️ **Interactive dashboard** with buttons, select menus, and modals — no CLI flags
- ⚡ **Live streaming** with debounced edits and code-block-aware splitting
- 🟢 **Reaction shortcuts**: 🛑 stop · 💰 show cost · 🧠 show memory

### Production-ready
- 💰 **Cost tracking** — every session logged with tokens, duration, model. `!costs` dashboard with daily/weekly/monthly views
- ⏰ **Session timeout** — auto-kill after 15 min without heartbeat, no zombie processes
- 🎯 **Per-channel `--max-turns`** — prevent runaway sessions
- 🤖 **Multi-model** — Opus for hard problems, Sonnet for analysis, Haiku for triage
- 🗃️ **SQLite persistence** — sessions, memory, activity, usage, settings — all survive restarts
- 🔒 **Secret hygiene** — Discord token stripped from subprocess env

---

## Quick start

```bash
git clone https://github.com/XavierKain/disclawd.git
cd disclawd
bun install
cp .env.example .env
# edit .env with your Discord bot token + IDs
bun run start
```

### `.env`

```env
DISCORD_BOT_TOKEN=your_bot_token
ALLOWED_USER_ID=your_discord_user_id
GUILD_ID=your_server_id
CLAUDE_MODEL=opus              # default model (opus, sonnet, haiku)
BASE_PROJECT_DIR=/home/user
```

### Prerequisites
- [Bun](https://bun.sh)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated with your subscription
- A Discord bot with **Message Content** and **Server Members** intents

---

## Configuring channels

You have two ways to configure channels:

### 1. Code defaults — `src/config.ts`

```typescript
export const CHANNEL_CONFIGS: Record<string, Partial<ChannelConfig>> = {
  "my-project": {
    projectDir: "/path/to/project",
    systemPrompt: "You are a coding assistant for this Next.js project.",
    streaming: true,
    model: "opus",
    maxTurns: 50,
    compactThreshold: 40,
  },
  "links": {
    systemPrompt: "Analyze any URL shared and provide a summary.",
    streaming: false,
    model: "sonnet",
    maxTurns: 3,
    compactThreshold: 20,
  },
};
```

### 2. Live config via Discord (no restart)

```
!dashboard          # interactive UI with buttons + dropdowns + modals
!config #channel    # quick view
!set max-turns 20   # set value for current channel
!set webcam model sonnet
!unset #channel     # reset to code defaults
```

The dashboard (`!dashboard`) is the easiest way: click buttons to edit, select dropdowns for models, type into modals for prompts. Settings are persisted in SQLite and override code defaults at runtime.

---

## Commands

| Command | Description |
|---------|-------------|
| `!dashboard` | Interactive config UI with buttons + select menus |
| `!status` | Active sessions + queues + heartbeats |
| `!stop [#channel]` | Stop a session |
| `!reset` | Clear current channel context |
| `!memory` | View compacted memories |
| `!costs [today\|week\|month\|all]` | Cost dashboard |
| `!set [#channel] key value` | Set a parameter |
| `!config [#channel\|all]` | View configuration |
| `!unset [#channel]` | Remove DB overrides |
| `!help` | List commands |

### Reactions
- 🛑 — stop the session in this channel
- 💰 — show cost (24h)
- 🧠 — show compacted memory

### Routing from #général
```
@#refonte-site fix the WebP images
dis à #pipeline de relancer le scraping
dans #système, vérifie les crons
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Discord Server                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ #général │ │ #refonte │ │ #système │  ...      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘          │
└───────┼─────────────┼────────────┼────────────────┘
        │             │            │
        ▼             ▼            ▼
┌──────────────────────────────────────────────────┐
│                 DisClawd (Bun)                     │
│                                                    │
│  index.ts ─── Message router + queue manager       │
│     │                                              │
│     ├── config.ts ─── Per-channel system prompts   │
│     │                  + DB-merged overrides        │
│     │                                              │
│     ├── claude-session.ts ─── Process spawner      │
│     │   ├── Bun.spawn("claude -p --stream-json")   │
│     │   ├── Heartbeat tracking + 15min timeout     │
│     │   └── Token usage accumulation               │
│     │                                              │
│     ├── dashboard.ts ─── Interactive UI builder    │
│     │   ├── Embeds for current config              │
│     │   ├── Buttons for actions                    │
│     │   ├── Select menus for choices               │
│     │   └── Modals for text input                  │
│     │                                              │
│     ├── database.ts ─── SQLite (WAL mode)          │
│     │   ├── sessions      (channel → session_id)   │
│     │   ├── memory        (compacted summaries)    │
│     │   ├── activity_log  (cross-channel events)   │
│     │   ├── usage_log     (cost + tokens per call) │
│     │   └── channel_settings (runtime overrides)   │
│     │                                              │
│     ├── discord-formatter.ts ─── Streaming UI      │
│     ├── memory.ts ─── Compaction engine            │
│     └── general-orchestrator.ts ─── Routing + digest │
└──────────────────────────────────────────────────┘
```

### Session lifecycle

```
Channel first message → Spawn claude -p (gets new session_id from init event)
                      → Store session_id in DB

Subsequent messages   → Resume with --resume <session_id>
                      → Same context, no cold start

After N messages      → Compaction: summarize → save to memory table
(N = compactThreshold)→ Reset session_id → next message starts fresh + memory

15min inactivity      → Auto-kill (no heartbeat)
User !reset           → Clear session_id → next message = fresh context
```

---

## Database schema

```sql
-- Per-channel session state
CREATE TABLE sessions (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  session_id TEXT,
  project_dir TEXT NOT NULL,
  message_count INTEGER,
  ...
);

-- Compacted conversation summaries
CREATE TABLE memory (
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER,
  ...
);

-- Cross-channel activity (injected into #général)
CREATE TABLE activity_log (...);

-- Per-session usage tracking
CREATE TABLE usage_log (
  channel_id TEXT NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER,
  num_turns INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  model TEXT,
  ...
);

-- Runtime config overrides (set via !dashboard or !set)
CREATE TABLE channel_settings (
  channel_name TEXT PRIMARY KEY,
  max_turns INTEGER,
  model TEXT,
  compact_threshold INTEGER,
  streaming INTEGER,
  system_prompt TEXT,
  project_dir TEXT,
  ...
);
```

---

## DisClawd vs OpenClaw vs raw Claude Code

| | DisClawd | OpenClaw | Raw Claude Code |
|---|---|---|---|
| Uses your Claude Code subscription | ✅ | ❌ (own runtime) | ✅ |
| Multi-session | ✅ 10 concurrent | ✅ | ❌ |
| Discord native | ✅ | ❌ | ❌ |
| Per-channel context | ✅ | ❌ | N/A |
| Memory compaction | ✅ Adaptive | Plugin | ❌ |
| Cost tracking | ✅ Built-in | Plugin | Manual |
| Visual config UI | ✅ Discord | ✅ Web | ❌ |
| Mobile access | ✅ Discord app | ❌ | ❌ |
| Self-hosted | ✅ Single binary | ✅ | ✅ |
| Setup complexity | Low (Bun + bot) | Medium | Low |

---

## Roadmap

- [ ] Webhook mode for automated channels (#liens, #newsletter)
- [ ] Multi-user support (currently single-user via `ALLOWED_USER_ID`)
- [ ] Slash commands (in addition to `!` prefix)
- [ ] Export usage data to CSV / Google Sheets
- [ ] Voice channel integration (transcribe → Claude → reply)
- [ ] Plugin system for custom tool handlers

---

## License

MIT — do whatever you want.
