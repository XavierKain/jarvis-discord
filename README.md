# Jarvis Discord — Multi-Session Claude Code Orchestrator

A Discord bot that turns each channel into an independent Claude Code agent with persistent sessions, memory compaction, cross-channel awareness, and real-time streaming.

**Built with:** Bun + Discord.js + SQLite + Claude Code CLI (`claude -p --output-format stream-json`)

---

## Why this exists

Claude Code is powerful but single-session. If you're running multiple projects — a website redesign, a lead pipeline, a YouTube automation, system admin — you need parallel, isolated AI sessions that maintain their own context.

Discord channels are the natural boundary: each channel = one agent, one project, one context. This bot spawns headless Claude Code processes per channel, streams output live, and handles session resumption, memory compaction, and inter-channel routing.

```
You (Discord)
  │
  ├── #refonte-site ──→ Claude session (Next.js project, /workspace/site)
  ├── #pipeline ──────→ Claude session (Lead gen, /workspace/pipeline)
  ├── #système ───────→ Claude session (VPS admin, /home/xavier)
  ├── #webcam ────────→ Claude session (Camera project, /home/xavier)
  └── #général ───────→ Claude session (HQ — sees all activity, routes commands)
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
│              jarvis-discord (Bun)                  │
│                                                    │
│  index.ts ─── Message router + queue manager       │
│     │                                              │
│     ├── config.ts ─── Per-channel system prompts   │
│     │                  + project directories        │
│     │                                              │
│     ├── claude-session.ts ─── Process spawner      │
│     │   └── Bun.spawn("claude -p --stream-json")   │
│     │                                              │
│     ├── database.ts ─── SQLite (WAL mode)          │
│     │   ├── sessions (channel → session_id)        │
│     │   ├── memory (compacted summaries)           │
│     │   └── activity_log (cross-channel events)    │
│     │                                              │
│     ├── discord-formatter.ts ─── StreamingResponse │
│     │   ├── Live text streaming (debounced edits)  │
│     │   ├── Todo list embeds (real-time)           │
│     │   └── Code block-aware message splitting     │
│     │                                              │
│     ├── memory.ts ─── Compaction engine            │
│     │   └── After 40 messages: summarize → reset   │
│     │                                              │
│     └── general-orchestrator.ts ─── Cross-channel  │
│         ├── Activity digest injection              │
│         └── Command routing (@#channel msg)         │
└──────────────────────────────────────────────────┘
```

### Core flow

1. **Message arrives** in a Discord channel
2. **Concurrency check** — max 5 simultaneous sessions across all channels
3. **Queue if busy** — if this channel already has an active session, queue the message (max 5 per channel), react with ⏳
4. **Load config** — per-channel system prompt + project directory
5. **Check compaction** — if message_count ≥ 40, ask Claude to summarize, save to memory table, reset session
6. **Inject context** — memories + activity digest (for #général)
7. **Spawn process** — `claude -p --output-format stream-json --resume <session_id> --model opus <message>`
8. **Stream output** — parse JSON events line by line, render live to Discord
9. **Track todos** — intercept TaskCreate/TaskUpdate events, show as Discord embeds
10. **On completion** — log activity, process queued messages, update session state

### Session lifecycle

```
Channel first message → Create DB record (session_id = null)
                      → Spawn claude -p (gets new session_id from init event)
                      → Store session_id in DB

Subsequent messages   → Resume with --resume <session_id>
                      → Same context, no cold start

After 40 messages     → Compaction: summarize → save to memory table
                      → Reset session_id to null (fresh session)
                      → Next message starts new session with memory injection

User sends !reset     → Clear session_id → next message = fresh context
```

---

## Features

### Per-channel isolation
Each channel gets its own Claude Code process with:
- **Custom system prompt** (e.g., "Tu es un agent de développement")
- **Custom working directory** (e.g., `/workspace/my-nextjs-app`)
- **Independent session persistence** via `--resume`

### Real-time streaming
Claude's output streams live to Discord via debounced message edits (1.5s throttle). Long outputs split across messages with code block awareness (properly closes/reopens ``` across splits).

### Todo list tracking
When Claude uses `TaskCreate`/`TaskUpdate` tools, the bot renders a live status embed:
```
🔄 Migrer les images en WebP
✅ Installer sharp
⬚ Déployer sur SiteGround
⚡ Édition de next.config.js
```

### Memory compaction
After 40 messages, the bot automatically:
1. Asks Claude to summarize the conversation (10-15 bullet points)
2. Saves the summary to a `memory` table
3. Resets the session — next message starts fresh with injected memories
4. **Post-compact guardrail**: prevents Claude from auto-executing "pending tasks" from the summary

### Cross-channel awareness (#général)
The `#général` channel acts as HQ:
- Receives an **activity digest** of all other channels injected into its system prompt
- Can **route commands** to other channels:
  ```
  @#refonte-site fix the WebP images
  dis à #pipeline de relancer le scraping
  dans #système, vérifie les crons
  ```

### Message queueing
When a channel's session is busy, messages queue up (max 5). Each queued message gets a ⏳ reaction. After the current session completes, the next message in queue is automatically processed.

### Commands
| Command | Description |
|---------|-------------|
| `!status` | Show active sessions and queues |
| `!stop [#channel]` | Stop a running session |
| `!reset` | Clear session context (start fresh) |
| `!memory` | View this channel's compacted memories |
| `!help` | List commands |

---

## Setup

### Prerequisites
- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Discord bot token with Message Content intent

### Installation

```bash
git clone https://github.com/XavierKain/jarvis-discord.git
cd jarvis-discord
bun install
```

### Configuration

Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your_bot_token
ALLOWED_USER_ID=your_discord_user_id
GUILD_ID=your_server_id
CLAUDE_MODEL=opus              # or sonnet, haiku
BASE_PROJECT_DIR=/home/user    # default working directory
```

Edit `src/config.ts` to define your channels:

```typescript
export const CHANNEL_CONFIGS: Record<string, Partial<ChannelConfig>> = {
  "my-project": {
    projectDir: "/path/to/project",
    systemPrompt: "You are a coding assistant for this Next.js project.",
    streaming: true,
  },
  "links": {
    projectDir: "/home/user",
    systemPrompt: "Analyze any URL shared and provide a summary.",
    streaming: false, // send final result only
  },
};
```

### Run

```bash
bun run start
# or with hot reload:
bun run dev
```

### As a systemd service

```ini
[Unit]
Description=Jarvis Discord Bot
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/jarvis-discord
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

---

## Database schema

SQLite with WAL mode, stored in `data/jarvis.db`:

```sql
-- One row per channel, tracks session state
CREATE TABLE sessions (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  session_id TEXT,            -- Claude Code session ID for --resume
  project_dir TEXT NOT NULL,
  last_activity INTEGER,
  message_count INTEGER,      -- triggers compaction at 40
  created_at INTEGER,
  updated_at INTEGER
);

-- Compacted conversation summaries
CREATE TABLE memory (
  channel_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (channel_id, created_at)
);

-- Cross-channel activity log (injected into #général)
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  event_type TEXT NOT NULL,    -- message, completed, error, routed
  summary TEXT NOT NULL,
  created_at INTEGER
);
```

---

## File structure

```
jarvis-discord/
├── src/
│   ├── index.ts                 # Discord bot + message router (364 lines)
│   ├── claude-session.ts        # Claude CLI process spawner (285 lines)
│   ├── config.ts                # Channel configs + env vars (92 lines)
│   ├── database.ts              # SQLite persistence layer (131 lines)
│   ├── discord-formatter.ts     # Streaming renderer + embeds (276 lines)
│   ├── general-orchestrator.ts  # Cross-channel routing + digest (71 lines)
│   ├── memory.ts                # Compaction engine (73 lines)
│   └── types.ts                 # TypeScript definitions (72 lines)
├── data/                        # SQLite DB (gitignored)
├── .env                         # Secrets (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

**Total: ~1,364 lines of TypeScript**

---

## How it compares

| Feature | jarvis-discord | Raw Claude Code | Claude Code + MCP |
|---------|---------------|----------------|-------------------|
| Multi-session | ✅ 5 concurrent | ❌ Single | ❌ Single |
| Discord native | ✅ | ❌ (needs plugin) | ❌ |
| Per-channel context | ✅ | N/A | N/A |
| Session resumption | ✅ `--resume` | ✅ manual | ✅ manual |
| Memory compaction | ✅ Auto at 40 msgs | ❌ | ❌ |
| Cross-channel awareness | ✅ Activity digest | N/A | N/A |
| Command routing | ✅ `@#channel msg` | N/A | N/A |
| Live streaming to Discord | ✅ Debounced edits | N/A | N/A |
| Todo tracking | ✅ Embeds | ✅ Terminal | ✅ Terminal |
| Message queueing | ✅ Per-channel | N/A | N/A |

---

## Design decisions

**Why Bun?** — Native SQLite binding, fast subprocess spawning, no node_modules bloat for runtime. Discord.js works seamlessly with Bun.

**Why SQLite?** — Zero-config persistence on a single VPS. WAL mode handles concurrent reads/writes. No external database dependency.

**Why spawn processes instead of the SDK?** — Claude Code CLI (`claude -p`) gives you the full toolchain (file editing, bash, web search, agents) in a single command. The SDK would require reimplementing all of that. The CLI's `--output-format stream-json` provides typed events we can parse and render.

**Why message queueing instead of multiplexing?** — Claude Code sessions are inherently sequential (one active tool use at a time). Queueing is simpler and matches the actual execution model.

**Why compaction over infinite context?** — Token costs scale linearly with context size. After 40 messages, resuming with a 15-line summary + fresh session is cheaper and often more focused than carrying full context.

---

## License

MIT
