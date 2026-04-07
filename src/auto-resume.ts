/**
 * Auto-Resume Module — Automatically retries tasks that were cut by rate limits, quotas, etc.
 *
 * Checks pending_tasks every 60s. When retry_after has passed, resumes the task
 * in the original Discord channel.
 */

import { Client, TextChannel, ChannelType } from "discord.js";
import type { CutInfo, CutReason, PendingTask } from "./types.js";
import {
  insertPendingTask,
  getWaitingTasks,
  getAllPendingTasks,
  getPendingTaskById,
  updatePendingTaskStatus,
  abandonPendingTask,
  countWaitingTasks,
} from "./database.js";
import { getChannelConfig } from "./config.js";

// Max retry attempts before giving up
const MAX_ATTEMPTS = 5;

// Check interval (ms)
const CHECK_INTERVAL_MS = 60_000; // 1 minute

// Longer check for weekly/monthly resets
const LONG_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes

let resumeTimer: ReturnType<typeof setInterval> | null = null;
let discordClient: Client | null = null;
let resumeCallback: ((task: PendingTask, channel: TextChannel) => Promise<void>) | null = null;

/**
 * Initialize the auto-resume checker.
 * @param client Discord client (to find channels)
 * @param onResume Callback when a task should be resumed
 */
export function initAutoResume(
  client: Client,
  onResume: (task: PendingTask, channel: TextChannel) => Promise<void>,
) {
  discordClient = client;
  resumeCallback = onResume;

  if (resumeTimer) clearInterval(resumeTimer);

  resumeTimer = setInterval(checkPendingTasks, CHECK_INTERVAL_MS);
  console.log("🔄 Auto-resume checker démarré (toutes les 60s)");
}

export function stopAutoResume() {
  if (resumeTimer) {
    clearInterval(resumeTimer);
    resumeTimer = null;
  }
  console.log("🔄 Auto-resume checker arrêté");
}

/**
 * Save a cut task for later automatic retry.
 */
export function savePendingTask(
  channelId: string,
  channelName: string,
  sessionId: string | null,
  originalPrompt: string,
  cutInfo: CutInfo,
  contextSummary?: string,
): number {
  const result = insertPendingTask(
    channelId,
    channelName,
    sessionId,
    originalPrompt,
    contextSummary || null,
    cutInfo.reason,
    cutInfo.message,
    cutInfo.retryAfter,
  );
  return (result as any).lastInsertRowid || 0;
}

/**
 * Check for tasks ready to be resumed.
 */
async function checkPendingTasks() {
  if (!discordClient || !resumeCallback) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const tasks = getWaitingTasks(nowSec);

  if (tasks.length === 0) return;

  console.log(`🔄 ${tasks.length} tâche(s) prête(s) à reprendre`);

  for (const task of tasks) {
    // Skip if too many attempts
    if (task.attempts >= MAX_ATTEMPTS) {
      console.log(`⚠️ Tâche #${task.id} abandonnée après ${MAX_ATTEMPTS} tentatives`);
      updatePendingTaskStatus(task.id, "failed");
      continue;
    }

    // Check if auto_resume is still enabled for this channel
    const config = getChannelConfig(task.channel_id, task.channel_name);
    if (!config.autoResume) {
      console.log(`⏭️ Auto-resume désactivé pour #${task.channel_name}, tâche #${task.id} ignorée`);
      continue;
    }

    // Find the Discord channel
    const channel = discordClient.channels.cache.get(task.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.log(`❌ Channel ${task.channel_id} introuvable, tâche #${task.id} ignorée`);
      continue;
    }

    const textChannel = channel as TextChannel;

    // Mark as resumed
    updatePendingTaskStatus(task.id, "resumed");

    try {
      // Notify the channel
      const attempt = task.attempts + 1;
      await textChannel.send(
        `🔄 **Reprise automatique** de la tâche #${task.id} (tentative ${attempt}/${MAX_ATTEMPTS})\n` +
        `📋 Coupée pour : ${task.cut_message}\n` +
        `💬 Prompt original : \`${task.original_prompt.slice(0, 100)}${task.original_prompt.length > 100 ? "..." : ""}\``,
      );

      // Resume the task
      await resumeCallback(task, textChannel);

      // Mark completed
      updatePendingTaskStatus(task.id, "completed");
    } catch (err) {
      console.error(`❌ Erreur reprise tâche #${task.id}:`, err);

      // Re-queue with extended retry
      const retryDelay = getRetryDelay(task.cut_reason as CutReason, task.attempts + 1);
      const newRetryAfter = Math.floor(Date.now() / 1000) + retryDelay;

      // Keep as waiting but with updated retry_after
      // We use a direct DB update here
      insertPendingTask(
        task.channel_id,
        task.channel_name,
        task.session_id,
        task.original_prompt,
        task.context_summary,
        task.cut_reason,
        task.cut_message,
        newRetryAfter,
      );
      // Mark old one as failed (the new one takes over)
      updatePendingTaskStatus(task.id, "failed");
    }
  }
}

/**
 * Get retry delay in seconds based on cut reason and attempt number.
 * Exponential backoff for rate limits, fixed for quota resets.
 */
function getRetryDelay(reason: CutReason, attempt: number): number {
  switch (reason) {
    case "rate_limit":
      return Math.min(120 * Math.pow(2, attempt - 1), 3600); // 2min -> 4min -> 8min -> ... max 1h
    case "session_timeout":
      return 10; // Almost immediate — new session
    case "max_turns":
      return 5; // Immediate — resume with "continue"
    case "weekly_quota": {
      // Next Monday 00:00 UTC
      const now = new Date();
      const day = now.getUTCDay();
      const daysUntilMonday = day === 0 ? 1 : 8 - day;
      return daysUntilMonday * 86400;
    }
    case "monthly_quota": {
      // 1st of next month
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return Math.floor((next.getTime() - Date.now()) / 1000);
    }
    default:
      return 300 * attempt; // 5min, 10min, 15min...
  }
}

// === Formatting helpers ===

/**
 * Format a CutInfo into a Discord message.
 */
export function formatCutMessage(cut: CutInfo, taskId: number): string {
  const retryDate = new Date(cut.retryAfter * 1000);
  const now = Date.now();
  const diffMs = cut.retryAfter * 1000 - now;

  let retryStr: string;
  if (diffMs <= 0) {
    retryStr = "immédiatement";
  } else if (diffMs < 60_000) {
    retryStr = `dans ${Math.ceil(diffMs / 1000)}s`;
  } else if (diffMs < 3600_000) {
    retryStr = `dans ${Math.ceil(diffMs / 60_000)} min`;
  } else if (diffMs < 86400_000) {
    retryStr = `dans ${Math.round(diffMs / 3600_000)}h`;
  } else {
    retryStr = `le ${retryDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} à ${retryDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }

  const emoji = getCutEmoji(cut.reason);
  return `${emoji} **Tâche coupée** — ${cut.message}\n` +
    `💾 Sauvegardée (tâche #${taskId}) — reprise auto ${retryStr}\n` +
    `ℹ️ \`!tasks\` pour voir la file · \`!cancel ${taskId}\` pour annuler`;
}

function getCutEmoji(reason: CutReason): string {
  switch (reason) {
    case "rate_limit": return "⏱️";
    case "session_timeout": return "⏰";
    case "weekly_quota": return "📅";
    case "monthly_quota": return "💳";
    case "max_turns": return "🔄";
    default: return "🔴";
  }
}

/**
 * Format pending tasks list for !tasks command.
 */
export function formatTasksList(tasks: PendingTask[]): string {
  if (tasks.length === 0) {
    return "📋 Aucune tâche en attente.";
  }

  let msg = `📋 **Tâches en attente (${tasks.length}) :**\n\n`;

  for (const task of tasks) {
    const statusEmoji = task.status === "waiting" ? "⏳" : task.status === "resumed" ? "🔄" : "✅";
    const retryDate = new Date(task.retry_after * 1000);
    const now = Date.now();
    const isPast = task.retry_after * 1000 <= now;

    const retryStr = isPast
      ? "prête à reprendre"
      : `reprise ${formatRelativeTime(task.retry_after * 1000 - now)}`;

    msg += `${statusEmoji} **#${task.id}** · #${task.channel_name} · ${getCutEmoji(task.cut_reason as CutReason)} ${task.cut_reason}\n`;
    msg += `   💬 \`${task.original_prompt.slice(0, 80)}${task.original_prompt.length > 80 ? "..." : ""}\`\n`;
    msg += `   📊 ${retryStr} · ${task.attempts} tentative(s)\n\n`;
  }

  return msg;
}

function formatRelativeTime(ms: number): string {
  if (ms < 60_000) return `dans ${Math.ceil(ms / 1000)}s`;
  if (ms < 3600_000) return `dans ${Math.ceil(ms / 60_000)} min`;
  if (ms < 86400_000) return `dans ${Math.round(ms / 3600_000)}h`;
  return `dans ${Math.round(ms / 86400_000)}j`;
}
