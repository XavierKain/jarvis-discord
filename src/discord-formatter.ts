import { Message, TextChannel, EmbedBuilder } from "discord.js";
import type { TodoItem, StreamResult } from "./types.js";
import { EDIT_DEBOUNCE_MS, MAX_MESSAGE_LENGTH } from "./config.js";

/**
 * Manages a single streaming response in a Discord channel.
 * - Maintains a "status" embed with the todo list (updated live)
 * - Accumulates text output and posts/edits messages with debounce
 * - Sends a final notification when done
 */
export class StreamingResponse {
  private channel: TextChannel;
  private textBuffer = "";
  private currentMessage: Message | null = null;
  private statusMessage: Message | null = null;
  private lastEditTime = 0;
  private editTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentTool = "";
  private isFinished = false;
  private messageChain: Message[] = [];
  private lastHeartbeat = Date.now();

  constructor(channel: TextChannel) {
    this.channel = channel;
  }

  /** Update the status embed with current todo list + activity */
  async updateStatus(todos: TodoItem[], currentActivity?: string) {
    const embed = buildTodoEmbed(todos, currentActivity);

    try {
      if (this.statusMessage) {
        await this.statusMessage.edit({ embeds: [embed] });
      } else {
        this.statusMessage = await this.channel.send({ embeds: [embed] });
      }
    } catch (err) {
      // Message might have been deleted, create new one
      try {
        this.statusMessage = await this.channel.send({ embeds: [embed] });
      } catch {}
    }
  }

  /** Append text from Claude's response */
  appendText(text: string) {
    this.textBuffer += text;
    this.scheduleEdit();
  }

  /** Show what tool is currently being used */
  setCurrentTool(toolName: string) {
    this.currentTool = toolName;
  }

  /** Heartbeat - show we're still alive */
  async heartbeat() {
    this.lastHeartbeat = Date.now();
    if (this.statusMessage && this.currentTool) {
      // Don't spam edits, just track it
    }
  }

  /** Flush all pending text to Discord */
  async flush() {
    if (this.editTimeout) {
      clearTimeout(this.editTimeout);
      this.editTimeout = null;
    }
    await this.doEdit();
  }

  /** Finalize - send completion message */
  async finish(result?: StreamResult | null) {
    this.isFinished = true;
    await this.flush();

    // Update status embed to show completed
    if (this.statusMessage) {
      try {
        const embed = new EmbedBuilder()
          .setColor(result?.is_error ? 0xcc0000 : 0x00cc66)
          .setDescription(result?.is_error ? "**Erreur**" : "**Terminé**")
          .setTimestamp();

        const footerParts: string[] = [];
        if (result?.duration_ms) footerParts.push(`${Math.round(result.duration_ms / 1000)}s`);
        if (result?.num_turns) footerParts.push(`${result.num_turns} tours`);
        if (result?.cost_usd) footerParts.push(`$${result.cost_usd.toFixed(4)}`);
        if (footerParts.length > 0) {
          embed.setFooter({ text: footerParts.join(" · ") });
        }

        await this.statusMessage.edit({ embeds: [embed] });
      } catch {}
    }

    // Send a new message (triggers notification) if we had streaming content
    if (this.messageChain.length > 0 || this.textBuffer.trim()) {
      try {
        const costInfo = result?.cost_usd ? ` ($${result.cost_usd.toFixed(4)})` : "";
        await this.channel.send(`Terminé.${costInfo}`);
      } catch {}
    }
  }

  /** Send error message */
  async sendError(error: string) {
    const truncated = error.length > 500 ? error.slice(0, 500) + "..." : error;
    try {
      await this.channel.send(`**Erreur:** \`\`\`${truncated}\`\`\``);
    } catch {}
  }

  private scheduleEdit() {
    if (this.editTimeout) return;

    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, EDIT_DEBOUNCE_MS - elapsed);

    this.editTimeout = setTimeout(async () => {
      this.editTimeout = null;
      await this.doEdit();
    }, delay);
  }

  private async doEdit() {
    if (!this.textBuffer.trim()) return;

    const text = this.textBuffer;
    this.textBuffer = "";

    // Split into chunks if needed
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      try {
        if (this.currentMessage && this.canAppendToMessage(chunk)) {
          // Try to edit/append to current message
          const currentContent = this.currentMessage.content || "";
          const newContent = currentContent + chunk;
          if (newContent.length <= MAX_MESSAGE_LENGTH) {
            await this.currentMessage.edit(newContent);
            this.lastEditTime = Date.now();
            continue;
          }
        }

        // Send new message
        this.currentMessage = await this.channel.send(chunk);
        this.messageChain.push(this.currentMessage);
        this.lastEditTime = Date.now();
      } catch (err) {
        // Rate limited or other error, retry next cycle
        this.textBuffer = chunk + this.textBuffer;
        break;
      }
    }
  }

  private canAppendToMessage(addition: string): boolean {
    if (!this.currentMessage) return false;
    const currentLen = this.currentMessage.content?.length || 0;
    return currentLen + addition.length <= MAX_MESSAGE_LENGTH;
  }
}

/** Split a message respecting code blocks */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = MAX_MESSAGE_LENGTH;

    // Try to split at a newline
    const lastNewline = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (lastNewline > MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = lastNewline + 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Handle code block boundaries
    const codeBlockMatches = chunk.match(/```/g);
    if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
      // Odd number of ``` means we're splitting inside a code block
      if (!inCodeBlock) {
        // Find the language of the last opening ```
        const lastOpen = chunk.lastIndexOf("```");
        const langMatch = chunk.slice(lastOpen + 3).match(/^(\w*)/);
        codeBlockLang = langMatch?.[1] || "";
        chunk += "\n```";
        remaining = "```" + codeBlockLang + "\n" + remaining;
      } else {
        chunk += "\n```";
        remaining = "```" + codeBlockLang + "\n" + remaining;
      }
      inCodeBlock = !inCodeBlock;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/** Build a Discord embed showing the todo list */
function buildTodoEmbed(todos: TodoItem[], currentActivity?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2) // Discord blurple
    .setTimestamp();

  if (todos.length === 0 && currentActivity) {
    embed.setDescription(`⚡ ${currentActivity}`);
    return embed;
  }

  if (todos.length > 0) {
    const lines = todos
      .filter(t => t.status !== "deleted")
      .map(t => {
        const icon = t.status === "completed" ? "✅"
          : t.status === "in_progress" ? "🔄"
          : "⬚";
        return `${icon} ${t.subject}`;
      });

    embed.setDescription(lines.join("\n"));
  }

  if (currentActivity) {
    embed.setFooter({ text: `⚡ ${currentActivity}` });
  }

  return embed;
}

/** Format a tool name for display (skip noisy tools) */
export function formatToolActivity(toolName: string, input: Record<string, unknown>): string | null {
  // Skip noisy internal tools
  const SKIP_TOOLS = ["Read", "Glob", "Grep", "TaskGet", "TaskList"];
  if (SKIP_TOOLS.includes(toolName)) return null;

  switch (toolName) {
    case "Edit":
      return `Édition de ${(input.file_path as string)?.split("/").pop() || "fichier"}`;
    case "Write":
      return `Création de ${(input.file_path as string)?.split("/").pop() || "fichier"}`;
    case "Bash":
      return `Exécution: ${truncate(input.command as string || "", 60)}`;
    case "TaskCreate":
      return `Nouvelle tâche: ${input.subject || ""}`;
    case "TaskUpdate":
      return `MAJ tâche #${input.taskId}`;
    case "WebSearch":
      return `Recherche: ${truncate(input.query as string || "", 60)}`;
    case "WebFetch":
      return `Fetch: ${truncate(input.url as string || "", 60)}`;
    case "Agent":
      return `Lancement sous-agent`;
    default:
      return `${toolName}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
