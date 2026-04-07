import { Subprocess } from "bun";
import type { StreamEvent, StreamResult, TodoItem, TokenUsage, CutInfo, CutReason } from "./types.js";

// Mutable result tracker (written via closure in handleStreamEvent)
interface SessionTracker {
  result: StreamResult | null;
  sessionId: string | null;
  model: string | null;
}
import { SESSION_TIMEOUT_MS } from "./config.js";
import { updateSessionId, incrementMessageCount, getSession, logUsage } from "./database.js";

export interface SessionCallbacks {
  onText: (text: string) => void;
  onTodoUpdate: (todos: TodoItem[]) => void;
  onToolUse: (toolName: string, toolInput: Record<string, unknown>) => void;
  onResult: (result: StreamResult | null) => void;
  onError: (error: string) => void;
  onSessionId: (sessionId: string) => void;
  onHeartbeat: () => void;
  onCut?: (cut: CutInfo, sessionId: string | null, prompt: string) => void;
}

interface ActiveProcess {
  proc: Subprocess;
  channelId: string;
  channelName: string;
  lastHeartbeat: number;
  abortController: AbortController;
}

const activeProcesses = new Map<string, ActiveProcess>();

// Env vars to strip from subprocess (security)
const STRIPPED_ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
];

// Session timeout checker (runs every 60s)
let timeoutChecker: ReturnType<typeof setInterval> | null = null;

export function startTimeoutChecker() {
  if (timeoutChecker) return;
  timeoutChecker = setInterval(() => {
    const now = Date.now();
    for (const [channelId, active] of activeProcesses.entries()) {
      if (now - active.lastHeartbeat > SESSION_TIMEOUT_MS) {
        console.log(`⏰ Timeout: session #${active.channelName} (${Math.round((now - active.lastHeartbeat) / 60000)} min sans heartbeat)`);
        stopSession(channelId).catch(() => {});
      }
    }
  }, 60_000);
}

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !STRIPPED_ENV_KEYS.includes(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function isSessionActive(channelId: string): boolean {
  return activeProcesses.has(channelId);
}

export function getActiveSessionCount(): number {
  return activeProcesses.size;
}

export function getActiveSessions(): { channelId: string; channelName: string; lastHeartbeat: number }[] {
  return Array.from(activeProcesses.values()).map(a => ({
    channelId: a.channelId,
    channelName: a.channelName,
    lastHeartbeat: a.lastHeartbeat,
  }));
}

export async function stopSession(channelId: string): Promise<void> {
  const active = activeProcesses.get(channelId);
  if (!active) return;

  // Graceful: SIGINT first (like pressing Escape in Claude Code)
  active.proc.kill("SIGINT");

  // Wait up to 10s, then force kill
  const timeout = setTimeout(() => {
    try { active.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { active.proc.kill("SIGKILL"); } catch {}
    }, 2000);
  }, 10000);

  try {
    await active.proc.exited;
  } finally {
    clearTimeout(timeout);
    activeProcesses.delete(channelId);
  }
}

export async function sendMessage(
  channelId: string,
  channelName: string,
  message: string,
  projectDir: string,
  systemPrompt: string,
  callbacks: SessionCallbacks,
  memories: string[] = [],
  options: { model?: string; maxTurns?: number } = {},
): Promise<void> {
  // If session is already active, stop it first (user sent new message)
  if (isSessionActive(channelId)) {
    await stopSession(channelId);
  }

  const session = getSession(channelId);
  const sessionId = session?.session_id;
  const model = options.model || "opus";

  // Build the full system prompt with memories
  let fullSystemPrompt = systemPrompt;
  if (memories.length > 0) {
    fullSystemPrompt += "\n\n## Mémoire de ce channel\n" + memories.join("\n---\n");
  }

  // Build claude command args
  const args: string[] = [
    "claude",
    "-p",
    "--output-format", "stream-json",
    "--model", model,
    "--verbose",
    "--dangerously-skip-permissions",
    "--system-prompt", fullSystemPrompt,
  ];

  // Max turns limit
  if (options.maxTurns && options.maxTurns > 0) {
    args.push("--max-turns", String(options.maxTurns));
  }

  // Resume existing session if we have one
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Add the message
  args.push(message);

  const abortController = new AbortController();
  const env = buildCleanEnv();

  const proc = Bun.spawn(args, {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });

  const now = Date.now();
  activeProcesses.set(channelId, { proc, channelId, channelName, lastHeartbeat: now, abortController });

  // Track todos and usage from this session
  const todos: TodoItem[] = [];
  const tracker: SessionTracker = {
    result: null,
    sessionId: sessionId || null,
    model: model,
  };
  const accumulatedUsage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  // Heartbeat timer
  const heartbeatInterval = setInterval(() => {
    const active = activeProcesses.get(channelId);
    if (active) {
      active.lastHeartbeat = Date.now();
      callbacks.onHeartbeat();
    }
  }, 15000);

  // Process stdout (stream-json)
  const processStream = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Update heartbeat on any data received
        const active = activeProcesses.get(channelId);
        if (active) active.lastHeartbeat = Date.now();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: StreamEvent = JSON.parse(line);
            handleStreamEvent(event, channelId, todos, callbacks, accumulatedUsage, tracker);
          } catch {
            // Not valid JSON, skip
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer);
          handleStreamEvent(event, channelId, todos, callbacks, accumulatedUsage, tracker);
        } catch {}
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        callbacks.onError(`Stream read error: ${err}`);
      }
    }
  };

  // Process stderr — also captures error text for cut detection
  let stderrFull = "";
  const processStderr = async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrFull += decoder.decode(value, { stream: true });
      }
    } catch {}

    // Filter out info/debug lines, only report real errors
    const errorLines = stderrFull
      .split("\n")
      .filter(l => l.trim() && !l.includes("INFO") && !l.includes("DEBUG") && !l.includes("Compressing"))
      .join("\n");

    if (errorLines.trim()) {
      callbacks.onError(errorLines.trim());
    }
  };

  // Close stdin immediately (we send the message via args)
  proc.stdin.end();

  // Run both streams concurrently
  await Promise.all([processStream(), processStderr()]);

  // Wait for process exit
  const exitCode = await proc.exited;
  clearInterval(heartbeatInterval);
  activeProcesses.delete(channelId);

  incrementMessageCount(channelId);

  // Log usage to DB
  const costUsd = tracker.result?.cost_usd || 0;
  const durationMs = tracker.result?.duration_ms || (Date.now() - now);
  const numTurns = tracker.result?.num_turns || 0;

  logUsage(
    channelId, channelName, tracker.sessionId,
    costUsd, durationMs, numTurns,
    accumulatedUsage.input_tokens, accumulatedUsage.output_tokens,
    accumulatedUsage.cache_read_input_tokens || 0,
    tracker.model,
  );

  // === Cut detection ===
  const cutInfo = detectCut(exitCode, stderrFull, tracker.result);
  if (cutInfo && callbacks.onCut) {
    callbacks.onCut(cutInfo, tracker.sessionId, message);
  }

  // Fire onResult callback — use accumulated data if result event was missing
  if (tracker.result) {
    callbacks.onResult(tracker.result);
  } else {
    // Construct a synthetic result from what we tracked
    callbacks.onResult({
      session_id: tracker.sessionId || "",
      cost_usd: costUsd,
      duration_ms: Date.now() - now,
      num_turns: numTurns,
      is_error: exitCode !== 0,
    });
  }

  if (exitCode !== 0 && exitCode !== null && !cutInfo) {
    callbacks.onError(`Claude exited with code ${exitCode}`);
  }
}

/**
 * Detect if a Claude session was cut due to rate limits, quotas, etc.
 * Returns CutInfo if a cut was detected, null otherwise.
 */
function detectCut(exitCode: number | null, stderr: string, result: StreamResult | null): CutInfo | null {
  const lower = stderr.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);

  // Rate limit (API-level, usually short)
  if (lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
    return {
      reason: "rate_limit",
      message: "Limite de débit API atteinte (rate limit). Reprise dans ~2 minutes.",
      retryAfter: nowSec + 120,
    };
  }

  // Monthly/billing quota exhausted
  if (lower.includes("billing") || lower.includes("insufficient_quota") || lower.includes("quota exceeded") || lower.includes("spending limit") || lower.includes("monthly") || lower.includes("credit")) {
    return {
      reason: "monthly_quota",
      message: "Quota mensuel / crédits épuisés. Reprise au prochain reset (1er du mois).",
      retryAfter: getNextMonthReset(),
    };
  }

  // Weekly usage limit (Claude Code subscription)
  if (lower.includes("weekly") || lower.includes("usage limit") || lower.includes("week") || lower.includes("hebdomadaire")) {
    return {
      reason: "weekly_quota",
      message: "Limite hebdomadaire Claude Code atteinte. Reprise au prochain lundi.",
      retryAfter: getNextMondayReset(),
    };
  }

  // Session 5h timeout
  if (lower.includes("session duration") || lower.includes("session limit") || lower.includes("5 hour") || lower.includes("session expired") || lower.includes("maximum session")) {
    return {
      reason: "session_timeout",
      message: "Session de 5h max atteinte. Reprise immédiate avec une nouvelle session.",
      retryAfter: nowSec + 10, // Retry almost immediately with a new session
    };
  }

  // Max turns reached (not really a "cut" but useful to know)
  if (lower.includes("max turns") || lower.includes("maximum turns") || lower.includes("turn limit")) {
    return {
      reason: "max_turns",
      message: "Nombre maximum de tours atteint.",
      retryAfter: nowSec + 5,
    };
  }

  // Check result.is_error with non-zero exit and no clear reason
  // This catches "unexpected" cuts
  if (exitCode && exitCode !== 0 && exitCode !== 42) {
    // Only flag as cut if the process was actually doing something (had turns)
    const hadTurns = result?.num_turns && result.num_turns > 0;
    if (hadTurns) {
      // Check if stderr mentions anything limit-related broadly
      if (lower.includes("limit") || lower.includes("quota") || lower.includes("exceed") || lower.includes("capacity")) {
        return {
          reason: "unknown",
          message: `Session coupée de manière inattendue (exit ${exitCode}). Reprise dans 5 min.`,
          retryAfter: nowSec + 300,
        };
      }
    }
  }

  return null;
}

/** Get unix timestamp for next Monday 00:00 UTC */
function getNextMondayReset(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntilMonday);
  next.setUTCHours(0, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

/** Get unix timestamp for 1st of next month 00:00 UTC */
function getNextMonthReset(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.floor(next.getTime() / 1000);
}

function handleStreamEvent(
  event: StreamEvent,
  channelId: string,
  todos: TodoItem[],
  callbacks: SessionCallbacks,
  accumulatedUsage: TokenUsage,
  tracker: SessionTracker,
) {
  // Capture session ID from any event that has it
  if (event.session_id) {
    updateSessionId(channelId, event.session_id);
    callbacks.onSessionId(event.session_id);
    tracker.sessionId = event.session_id;
  }

  switch (event.type) {
    case "system":
      if (event.subtype === "init" && event.session_id) {
        updateSessionId(channelId, event.session_id);
        callbacks.onSessionId(event.session_id);
        tracker.sessionId = event.session_id;
      }
      break;

    case "assistant":
      if (event.message?.content) {
        // Track model from message
        if (event.message.model) {
          tracker.model = event.message.model;
        }

        // Accumulate token usage
        if (event.message.usage) {
          accumulatedUsage.input_tokens += event.message.usage.input_tokens || 0;
          accumulatedUsage.output_tokens += event.message.usage.output_tokens || 0;
          accumulatedUsage.cache_read_input_tokens = (accumulatedUsage.cache_read_input_tokens || 0) + (event.message.usage.cache_read_input_tokens || 0);
        }

        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            callbacks.onText(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            callbacks.onToolUse(block.name, block.input || {});

            // Intercept TaskCreate / TaskUpdate
            if (block.name === "TaskCreate" && block.input) {
              const input = block.input as any;
              const newTodo: TodoItem = {
                id: String(todos.length + 1),
                subject: input.subject || "Untitled",
                status: "pending",
                description: input.description,
              };
              todos.push(newTodo);
              callbacks.onTodoUpdate([...todos]);
            }
            if (block.name === "TaskUpdate" && block.input) {
              const input = block.input as any;
              const todo = todos.find(t => t.id === input.taskId);
              if (todo) {
                if (input.status) todo.status = input.status;
                if (input.subject) todo.subject = input.subject;
                callbacks.onTodoUpdate([...todos]);
              }
            }
          }
        }
      }
      break;

    case "result":
      if (event.result) {
        tracker.result = event.result;
        // Don't call callbacks.onResult here — it's called after process exit
        // to ensure we always fire it even if no result event was emitted
      }
      break;
  }
}

// Graceful shutdown: stop all active sessions
export async function shutdownAll(): Promise<void> {
  if (timeoutChecker) {
    clearInterval(timeoutChecker);
    timeoutChecker = null;
  }
  const channels = Array.from(activeProcesses.keys());
  await Promise.all(channels.map(ch => stopSession(ch)));
}
