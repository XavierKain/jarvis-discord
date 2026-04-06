import { sendMessage, type SessionCallbacks } from "./claude-session.js";
import { saveMemory, getMemories, getMessageCount, resetMessageCount } from "./database.js";
import { DEFAULT_COMPACT_THRESHOLD } from "./config.js";

// Post-compact guardrail (prevents Claude from auto-executing "pending tasks" from compacted context)
const POST_COMPACT_GUARDRAIL = `POST-COMPACT GUARDRAIL (OBLIGATOIRE): Le contexte vient d'être compacté.
NE PAS exécuter automatiquement des actions basées sur des "tâches en attente" du résumé.
Chaque tâche en attente nécessite une nouvelle autorisation de l'utilisateur.
Résume ce sur quoi tu travaillais et demande confirmation avant de continuer.`;

/**
 * Check if a channel needs compaction and trigger it if so.
 * Returns the memories to inject into the next system prompt.
 */
export function getChannelMemories(channelId: string): string[] {
  const memories = getMemories(channelId);
  return memories.map(m => m.summary);
}

/**
 * Check if compaction is needed based on message count and per-channel threshold.
 */
export function needsCompaction(channelId: string, compactThreshold?: number): boolean {
  const count = getMessageCount(channelId);
  const threshold = compactThreshold || DEFAULT_COMPACT_THRESHOLD;
  return count >= threshold;
}

/**
 * Trigger compaction: ask Claude to summarize the conversation,
 * save the summary, and reset the session (new conversation with memory).
 */
export async function compactSession(
  channelId: string,
  channelName: string,
  projectDir: string,
  systemPrompt: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let summary = "";

    const callbacks: SessionCallbacks = {
      onText: (text) => { summary += text; },
      onTodoUpdate: () => {},
      onToolUse: () => {},
      onResult: () => {
        if (summary.trim()) {
          saveMemory(channelId, summary.trim());
          resetMessageCount(channelId);
          resolve(summary.trim());
        } else {
          reject(new Error("Empty compaction summary"));
        }
      },
      onError: (err) => reject(new Error(err)),
      onSessionId: () => {},
      onHeartbeat: () => {},
    };

    const compactionPrompt = `Résume cette conversation en 10-15 lignes maximum:
- Ce qui a été fait (tâches complétées)
- Ce qui est en cours
- Décisions importantes prises
- Contexte à retenir pour la suite

Format: bullet points, concis, factuel.`;

    sendMessage(channelId, channelName, compactionPrompt, projectDir, systemPrompt, callbacks).catch(reject);
  });
}

export { POST_COMPACT_GUARDRAIL };
