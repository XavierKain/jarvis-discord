import { Client, GatewayIntentBits, TextChannel, Message, ChannelType, Interaction } from "discord.js";
import {
  buildDashboardEmbed,
  buildChannelSelector,
  handleDashboardButton,
  handleDashboardSelect,
  handleDashboardModal,
} from "./dashboard.js";
import {
  DISCORD_TOKEN, ALLOWED_USER_ID, GUILD_ID,
  MAX_CONCURRENT_SESSIONS, getChannelConfig,
} from "./config.js";
import { upsertSession, getSession, getCostsByChannel, getTotalCosts, getDailyCosts, upsertChannelSetting, getAllChannelSettings, deleteChannelSetting } from "./database.js";
import {
  sendMessage, isSessionActive, getActiveSessionCount, getActiveSessions, shutdownAll, stopSession, startTimeoutChecker,
  type SessionCallbacks,
} from "./claude-session.js";
import { StreamingResponse, formatToolActivity } from "./discord-formatter.js";
import { getChannelMemories, needsCompaction, compactSession, POST_COMPACT_GUARDRAIL } from "./memory.js";
import {
  trackActivity, buildActivityDigest, parseRouteCommand,
} from "./general-orchestrator.js";
import type { TodoItem } from "./types.js";

// Message queue per channel (when session is busy)
const messageQueues = new Map<string, { message: string; discordMsg: Message }[]>();

// General channel ID
const GENERAL_CHANNEL_ID = "1489964893712158811";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.once("clientReady", () => {
  console.log(`🤖 Jarvis connecté en tant que ${client.user?.tag}`);
  console.log(`📡 Guild: ${GUILD_ID}`);
  console.log(`👤 Utilisateur autorisé: ${ALLOWED_USER_ID}`);
  console.log(`🔧 Max sessions concurrentes: ${MAX_CONCURRENT_SESSIONS}`);

  // Start the session timeout checker
  startTimeoutChecker();
});

client.on("messageCreate", async (message: Message) => {
  // Ignore bots and non-guild messages
  if (message.author.bot) return;
  if (!message.guild || message.guild.id !== GUILD_ID) return;

  // Only respond to allowed user
  if (message.author.id !== ALLOWED_USER_ID) return;

  // Only handle text channels
  if (message.channel.type !== ChannelType.GuildText) return;

  const channel = message.channel as TextChannel;
  const channelName = channel.name;
  const channelId = channel.id;
  const content = message.content.trim();

  // Ignore empty messages
  if (!content) return;

  // Handle special commands
  if (content.startsWith("!")) {
    await handleCommand(content.slice(1).trim(), channel, message);
    return;
  }

  // Check concurrent session limit
  if (!isSessionActive(channelId) && getActiveSessionCount() >= MAX_CONCURRENT_SESSIONS) {
    await channel.send(`⚠️ ${MAX_CONCURRENT_SESSIONS} sessions actives. Attends qu'une se termine ou utilise \`!stop #channel\`.`);
    return;
  }

  // If session is active in this channel, queue the message
  if (isSessionActive(channelId)) {
    const queue = messageQueues.get(channelId) || [];
    if (queue.length >= 5) {
      await channel.send("⚠️ File d'attente pleine (5 messages). Attends que la session termine.");
      return;
    }
    queue.push({ message: content, discordMsg: message });
    messageQueues.set(channelId, queue);
    await message.react("⏳");
    return;
  }

  await processMessage(channelId, channelName, content, channel, message);
});

// Handle reaction-based commands
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (user.id !== ALLOWED_USER_ID) return;

  const emoji = reaction.emoji.name;
  const channel = reaction.message.channel;
  if (channel.type !== ChannelType.GuildText) return;

  const textChannel = channel as TextChannel;

  switch (emoji) {
    case "🛑": {
      // Stop current session in this channel
      if (isSessionActive(textChannel.id)) {
        await stopSession(textChannel.id);
        await textChannel.send("⏹️ Session arrêtée via réaction.");
      }
      break;
    }
    case "💰": {
      // Show cost of last session
      const since = Math.floor(Date.now() / 1000) - 86400; // last 24h
      const costs = getCostsByChannel(since);
      const channelCost = costs.find((c: any) => c.channel_name === textChannel.name);
      if (channelCost) {
        await textChannel.send(`💰 **#${textChannel.name} (24h):** $${channelCost.total_cost.toFixed(4)} · ${channelCost.sessions} sessions · ${channelCost.total_turns} tours`);
      } else {
        await textChannel.send(`💰 Aucune donnée de coût pour #${textChannel.name} (24h).`);
      }
      break;
    }
    case "🧠": {
      // Show channel memory
      const memories = getChannelMemories(textChannel.id);
      if (memories.length === 0) {
        await textChannel.send("🧠 Aucune mémoire compactée pour ce channel.");
      } else {
        const text = memories.map((m, i) => `**${i + 1}.** ${m.slice(0, 200)}${m.length > 200 ? "..." : ""}`).join("\n\n");
        await textChannel.send(`🧠 **Mémoire de #${textChannel.name}:**\n${text}`);
      }
      break;
    }
  }
});

// Handle Discord component interactions (buttons, selects, modals)
client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.user.id !== ALLOWED_USER_ID) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "❌ Tu n'es pas autorisé.", ephemeral: true });
    }
    return;
  }

  try {
    if (interaction.isButton()) {
      await handleDashboardButton(interaction, client, GUILD_ID);
    } else if (interaction.isStringSelectMenu()) {
      await handleDashboardSelect(interaction, client, GUILD_ID);
    } else if (interaction.isModalSubmit()) {
      await handleDashboardModal(interaction, client, GUILD_ID);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.isRepliable() && !interaction.replied) {
      try {
        await interaction.reply({ content: `❌ Erreur: ${err}`, ephemeral: true });
      } catch {}
    }
  }
});

async function processMessage(
  channelId: string,
  channelName: string,
  content: string,
  channel: TextChannel,
  discordMessage: Message,
) {
  const config = getChannelConfig(channelId, channelName);

  // Initialize session in DB
  upsertSession(channelId, channelName, getSession(channelId)?.session_id || null, config.projectDir);

  // Check if compaction is needed (using per-channel threshold)
  if (needsCompaction(channelId, config.compactThreshold)) {
    await channel.send("🧠 Compaction de la mémoire en cours...");
    try {
      const summary = await compactSession(channelId, channelName, config.projectDir, config.systemPrompt);
      trackActivity(channelId, channelName, "compaction", `Mémoire compactée: ${summary.slice(0, 100)}...`);
      // Reset session so next message starts fresh with memory
      upsertSession(channelId, channelName, null, config.projectDir);
    } catch (err) {
      await channel.send(`⚠️ Erreur de compaction: ${err}`);
    }
  }

  // Get channel memories
  const memories = getChannelMemories(channelId);

  // Build system prompt - add activity digest for #général
  let systemPrompt = config.systemPrompt;
  if (channelId === GENERAL_CHANNEL_ID) {
    systemPrompt += "\n\n" + buildActivityDigest();
  }

  // Check for route commands from #général
  if (channelId === GENERAL_CHANNEL_ID) {
    const routeCmd = parseRouteCommand(content);
    if (routeCmd) {
      await routeToChannel(routeCmd.targetChannel, routeCmd.command, channel);
      return;
    }
  }

  // Show typing
  await discordMessage.react("⚡");

  // Create streaming response handler
  const streamer = new StreamingResponse(channel);
  let currentTodos: TodoItem[] = [];

  const callbacks: SessionCallbacks = {
    onText: (text) => {
      if (config.streaming) {
        streamer.appendText(text);
      }
    },
    onTodoUpdate: (todos) => {
      currentTodos = todos;
      if (config.streaming) {
        streamer.updateStatus(todos, streamer["currentTool"] || undefined);
      }
    },
    onToolUse: (toolName, input) => {
      const activity = formatToolActivity(toolName, input);
      if (activity) {
        streamer.setCurrentTool(activity);
        if (config.streaming) {
          streamer.updateStatus(currentTodos, activity);
        }
      }
    },
    onResult: async (result) => {
      await streamer.flush();

      if (!config.streaming) {
        // For non-streaming channels, send the accumulated text now
        // (it was buffered but not sent during streaming)
      }

      await streamer.finish(result);

      // Log activity for #général with actual metrics
      const costStr = result?.cost_usd ? ` · $${result.cost_usd.toFixed(4)}` : "";
      trackActivity(channelId, channelName, "completed",
        `Session terminée (${result?.num_turns || 0} tours, ${Math.round((result?.duration_ms || 0) / 1000)}s${costStr})`
      );

      // Remove reaction
      try { await discordMessage.reactions.cache.get("⚡")?.users.remove(client.user!.id); } catch {}

      // Process queued messages
      processQueue(channelId, channelName, channel);
    },
    onError: async (error) => {
      await streamer.sendError(error);
      trackActivity(channelId, channelName, "error", error.slice(0, 200));
    },
    onSessionId: (sessionId) => {
      upsertSession(channelId, channelName, sessionId, config.projectDir);
    },
    onHeartbeat: () => {
      streamer.heartbeat();
    },
  };

  // Log activity
  trackActivity(channelId, channelName, "message", content.slice(0, 200));

  try {
    await sendMessage(channelId, channelName, content, config.projectDir, systemPrompt, callbacks, memories, {
      model: config.model,
      maxTurns: config.maxTurns,
    });
  } catch (err) {
    await channel.send(`**Erreur:** ${err}`);
    trackActivity(channelId, channelName, "error", String(err).slice(0, 200));
  }
}

async function processQueue(channelId: string, channelName: string, channel: TextChannel) {
  const queue = messageQueues.get(channelId);
  if (!queue || queue.length === 0) return;

  const next = queue.shift()!;
  if (queue.length === 0) messageQueues.delete(channelId);

  // Remove ⏳ reaction
  try { await next.discordMsg.reactions.cache.get("⏳")?.users.remove(client.user!.id); } catch {}

  await processMessage(channelId, channelName, next.message, channel, next.discordMsg);
}

async function routeToChannel(targetChannelName: string, command: string, sourceChannel: TextChannel) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const targetChannel = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name === targetChannelName
  ) as TextChannel | undefined;

  if (!targetChannel) {
    await sourceChannel.send(`❌ Channel #${targetChannelName} introuvable.`);
    return;
  }

  await sourceChannel.send(`📤 Commande routée vers #${targetChannelName}: ${command.slice(0, 100)}`);

  // Send the command to the target channel
  await targetChannel.send(`📥 **Commande de #général:** ${command}`);

  // Trigger processing in the target channel
  const config = getChannelConfig(targetChannel.id, targetChannelName);
  upsertSession(targetChannel.id, targetChannelName, getSession(targetChannel.id)?.session_id || null, config.projectDir);

  const memories = getChannelMemories(targetChannel.id);
  const streamer = new StreamingResponse(targetChannel);
  let currentTodos: TodoItem[] = [];

  const callbacks: SessionCallbacks = {
    onText: (text) => { if (config.streaming) streamer.appendText(text); },
    onTodoUpdate: (todos) => { currentTodos = todos; if (config.streaming) streamer.updateStatus(todos); },
    onToolUse: (toolName, input) => {
      const activity = formatToolActivity(toolName, input);
      if (activity && config.streaming) streamer.updateStatus(currentTodos, activity);
    },
    onResult: async (result) => {
      await streamer.flush();
      await streamer.finish(result);
      trackActivity(targetChannel.id, targetChannelName, "routed-completed",
        `Commande de #général terminée: ${command.slice(0, 100)}`
      );
      await sourceChannel.send(`✅ #${targetChannelName} a terminé la commande.`);
    },
    onError: (err) => streamer.sendError(err),
    onSessionId: (sid) => upsertSession(targetChannel.id, targetChannelName, sid, config.projectDir),
    onHeartbeat: () => streamer.heartbeat(),
  };

  trackActivity(targetChannel.id, targetChannelName, "routed", `Commande de #général: ${command.slice(0, 100)}`);

  try {
    await sendMessage(targetChannel.id, targetChannelName, command, config.projectDir, config.systemPrompt, callbacks, memories, {
      model: config.model,
      maxTurns: config.maxTurns,
    });
  } catch (err) {
    await sourceChannel.send(`❌ Erreur dans #${targetChannelName}: ${err}`);
  }
}

async function handleCommand(cmd: string, channel: TextChannel, message: Message) {
  const parts = cmd.split(/\s+/);
  const action = parts[0]?.toLowerCase();

  switch (action) {
    case "dashboard":
    case "dash": {
      await channel.send({
        embeds: [buildDashboardEmbed(client, GUILD_ID)],
        components: [buildChannelSelector(client, GUILD_ID)],
      });
      break;
    }

    case "status": {
      const activeSessions = getActiveSessions();
      const queues = Array.from(messageQueues.entries())
        .filter(([_, q]) => q.length > 0)
        .map(([id, q]) => `  #${client.channels.cache.get(id)?.toString() || id}: ${q.length} en attente`);

      let status = `**Sessions actives:** ${activeSessions.length}/${MAX_CONCURRENT_SESSIONS}`;
      if (activeSessions.length > 0) {
        const details = activeSessions.map(s => {
          const age = Math.round((Date.now() - s.lastHeartbeat) / 1000);
          return `  #${s.channelName} (dernier heartbeat: ${age}s)`;
        });
        status += "\n" + details.join("\n");
      }
      if (queues.length > 0) status += "\n**Files d'attente:**\n" + queues.join("\n");
      await channel.send(status);
      break;
    }

    case "stop": {
      const target = parts[1]?.replace("#", "");
      if (target) {
        const guild = client.guilds.cache.get(GUILD_ID);
        const ch = guild?.channels.cache.find(c => c.name === target);
        if (ch) {
          await stopSession(ch.id);
          await channel.send(`⏹️ Session #${target} arrêtée.`);
        } else {
          await channel.send(`❌ Channel #${target} introuvable.`);
        }
      } else {
        await stopSession(channel.id);
        await channel.send("⏹️ Session arrêtée.");
      }
      break;
    }

    case "reset": {
      upsertSession(channel.id, channel.name, null, getChannelConfig(channel.id, channel.name).projectDir);
      await channel.send("🔄 Session réinitialisée. Prochaine conversation = nouveau contexte.");
      break;
    }

    case "memory": {
      const memories = getChannelMemories(channel.id);
      if (memories.length === 0) {
        await channel.send("Aucune mémoire pour ce channel.");
      } else {
        const text = memories.map((m, i) => `**${i + 1}.** ${m.slice(0, 200)}${m.length > 200 ? "..." : ""}`).join("\n\n");
        await channel.send(`**Mémoire de #${channel.name}:**\n${text}`);
      }
      break;
    }

    case "costs":
    case "cost":
    case "usage": {
      const period = parts[1] || "today";
      let since: number;
      const now = Math.floor(Date.now() / 1000);

      switch (period) {
        case "week": since = now - 7 * 86400; break;
        case "month": since = now - 30 * 86400; break;
        case "all": since = 0; break;
        default: since = now - 86400; break; // today
      }

      const total = getTotalCosts(since);
      const byChannel = getCostsByChannel(since);
      const daily = getDailyCosts();

      let msg = `**💰 Coûts (${period}):**\n`;
      msg += `Total: **$${(total?.total_cost || 0).toFixed(4)}** · ${total?.sessions || 0} sessions · ${total?.total_turns || 0} tours\n\n`;

      if (byChannel.length > 0) {
        msg += "**Par channel:**\n";
        for (const c of byChannel) {
          msg += `  #${c.channel_name}: $${c.total_cost.toFixed(4)} (${c.sessions} sessions, ${c.total_turns} tours)\n`;
        }
      }

      if (daily.length > 0 && period !== "today") {
        msg += "\n**Par jour (14 derniers):**\n";
        for (const d of daily.slice(0, 7)) {
          msg += `  ${d.day}: $${d.cost.toFixed(4)} (${d.sessions} sessions)\n`;
        }
      }

      await channel.send(msg);
      break;
    }

    case "set": {
      // !set channel-name key value
      // !set max-turns 20 (current channel)
      // !set webcam model sonnet
      let targetChannel: string;
      let key: string;
      let value: string;

      if (parts.length >= 4) {
        // !set channel-name key value
        targetChannel = parts[1];
        key = parts[2];
        value = parts.slice(3).join(" ");
      } else if (parts.length === 3) {
        // !set key value (current channel)
        targetChannel = channel.name;
        key = parts[1];
        value = parts[2];
      } else {
        await channel.send(`**Usage:** \`!set [channel] key value\`
**Clés disponibles:** max-turns, model, compact-threshold, streaming, project-dir
**Exemples:**
\`!set max-turns 20\` — ce channel
\`!set webcam model sonnet\` — channel spécifique
\`!set liens streaming false\``);
        break;
      }

      const settings: Record<string, any> = {};
      switch (key) {
        case "max-turns":
        case "maxturns":
          settings.max_turns = parseInt(value) || 0;
          break;
        case "model":
          if (!["opus", "sonnet", "haiku"].includes(value)) {
            await channel.send(`❌ Modèle invalide. Choix: opus, sonnet, haiku`);
            return;
          }
          settings.model = value;
          break;
        case "compact-threshold":
        case "compact":
          settings.compact_threshold = parseInt(value) || 40;
          break;
        case "streaming":
          settings.streaming = value === "true" || value === "1" ? 1 : 0;
          break;
        case "project-dir":
        case "dir":
          settings.project_dir = value;
          break;
        default:
          await channel.send(`❌ Clé inconnue: \`${key}\`. Valides: max-turns, model, compact-threshold, streaming, project-dir`);
          return;
      }

      upsertChannelSetting(targetChannel, settings);
      await channel.send(`✅ **#${targetChannel}**: \`${key}\` = \`${value}\``);
      break;
    }

    case "config": {
      // Show all channel configs
      const target = parts[1]?.replace("#", "") || channel.name;
      const config = getChannelConfig(channel.id, target);
      const dbSettings = getAllChannelSettings();

      if (parts[1] === "all" || parts[1] === "list") {
        let msg = "**⚙️ Configuration des channels:**\n\n";
        // Show DB overrides
        if (dbSettings.length > 0) {
          msg += "**Overrides (via !set):**\n";
          for (const s of dbSettings) {
            const fields = [];
            if (s.max_turns != null) fields.push(`max-turns=${s.max_turns}`);
            if (s.model != null) fields.push(`model=${s.model}`);
            if (s.compact_threshold != null) fields.push(`compact=${s.compact_threshold}`);
            if (s.streaming != null) fields.push(`streaming=${!!s.streaming}`);
            if (fields.length > 0) {
              msg += `  #${s.channel_name}: ${fields.join(", ")}\n`;
            }
          }
        } else {
          msg += "Aucun override. Tout est en config par défaut.\n";
        }
        await channel.send(msg);
      } else {
        await channel.send(`**⚙️ Config de #${target}:**
  Model: \`${config.model}\`
  Max turns: \`${config.maxTurns || "illimité"}\`
  Compaction: \`${config.compactThreshold} messages\`
  Streaming: \`${config.streaming}\`
  Project dir: \`${config.projectDir}\`
  System prompt: \`${config.systemPrompt.slice(0, 100)}...\``);
      }
      break;
    }

    case "unset": {
      // !unset channel-name — remove all DB overrides
      const target = parts[1]?.replace("#", "") || channel.name;
      deleteChannelSetting(target);
      await channel.send(`🗑️ Overrides supprimés pour #${target}. Retour aux valeurs par défaut.`);
      break;
    }

    case "help": {
      await channel.send(`**Commandes DisClawd:**
\`!dashboard\` — 🦅 Interface de configuration interactive (boutons, dropdowns)
\`!status\` — Sessions actives et files d'attente
\`!stop [#channel]\` — Arrêter une session
\`!reset\` — Réinitialiser le contexte de ce channel
\`!memory\` — Voir la mémoire de ce channel
\`!costs [today|week|month|all]\` — Dashboard des coûts
\`!set [channel] key value\` — Modifier un paramètre
\`!config [channel|all]\` — Voir la configuration
\`!unset [channel]\` — Supprimer les overrides
\`!help\` — Cette aide

**Réactions rapides:**
🛑 — Arrêter la session du channel
💰 — Voir le coût (24h)
🧠 — Voir la mémoire compactée

**Depuis #général:**
\`@#channel-name message\` — Envoyer une commande à un autre channel
\`dis à #channel-name de ...\` — Idem en français
\`dans #channel-name, ...\` — Idem`);
      break;
    }

    default:
      await channel.send(`Commande inconnue: \`${action}\`. Tape \`!help\` pour la liste.`);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Arrêt en cours...");
  await shutdownAll();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM reçu, arrêt...");
  await shutdownAll();
  client.destroy();
  process.exit(0);
});

// Start
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Échec de connexion Discord:", err);
  process.exit(1);
});
