import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type Client,
  ChannelType,
} from "discord.js";
import { getChannelConfig } from "./config.js";
import { getAllChannelSettings, upsertChannelSetting, deleteChannelSetting } from "./database.js";

/**
 * Build the main dashboard embed showing all channels and their effective config.
 */
export function buildDashboardEmbed(client: Client, guildId: string): EmbedBuilder {
  const guild = client.guilds.cache.get(guildId);
  const dbSettings = getAllChannelSettings();
  const overridesByName = new Map(dbSettings.map((s: any) => [s.channel_name, s]));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🦅 DisClawd — Configuration Dashboard")
    .setDescription("Sélectionne un channel ci-dessous pour voir et modifier sa config.\n\n**Légende:** ✏️ = override actif · ⚙️ = config par défaut")
    .setTimestamp();

  // List text channels with summary
  const channels = guild?.channels.cache
    .filter((ch): ch is TextChannel => ch.type === ChannelType.GuildText)
    .sort((a: TextChannel, b: TextChannel) => a.name.localeCompare(b.name));

  if (channels && channels.size > 0) {
    const lines: string[] = [];
    channels.forEach((ch: TextChannel) => {
      const config = getChannelConfig(ch.id, ch.name);
      const hasOverride = overridesByName.has(ch.name);
      const icon = hasOverride ? "✏️" : "⚙️";
      const modelEmoji = config.model === "opus" ? "🔴" : config.model === "sonnet" ? "🟡" : "🟢";
      const turns = config.maxTurns > 0 ? `${config.maxTurns}t` : "∞";
      lines.push(`${icon} **#${ch.name}** ${modelEmoji} \`${config.model}\` · max=\`${turns}\` · compact=\`${config.compactThreshold}\``);
    });

    // Discord embed field max 1024 chars — chunk if needed
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      if ((current + line + "\n").length > 1000) {
        chunks.push(current);
        current = "";
      }
      current += line + "\n";
    }
    if (current) chunks.push(current);

    chunks.forEach((chunk, i) => {
      embed.addFields({ name: i === 0 ? "Channels" : "\u200b", value: chunk, inline: false });
    });
  }

  embed.setFooter({ text: "🔴 Opus · 🟡 Sonnet · 🟢 Haiku · ✏️ override · ⚙️ default" });
  return embed;
}

/**
 * Build a per-channel detail embed.
 */
export function buildChannelDetailEmbed(channelId: string, channelName: string): EmbedBuilder {
  const config = getChannelConfig(channelId, channelName);
  const dbSettings = getAllChannelSettings();
  const override = dbSettings.find((s: any) => s.channel_name === channelName);

  const embed = new EmbedBuilder()
    .setColor(override ? 0xfaa61a : 0x5865f2)
    .setTitle(`⚙️ #${channelName}`)
    .setDescription(override ? "**Mode:** ✏️ override DB actif" : "**Mode:** ⚙️ config par défaut (code)")
    .addFields(
      { name: "🤖 Model", value: `\`${config.model}\``, inline: true },
      { name: "🔢 Max turns", value: config.maxTurns > 0 ? `\`${config.maxTurns}\`` : "`illimité`", inline: true },
      { name: "🧠 Compaction", value: `\`${config.compactThreshold} msgs\``, inline: true },
      { name: "📡 Streaming", value: config.streaming ? "`activé`" : "`désactivé`", inline: true },
      { name: "📁 Project dir", value: `\`${config.projectDir}\``, inline: false },
      { name: "💬 System prompt", value: `\`\`\`${config.systemPrompt.slice(0, 500)}${config.systemPrompt.length > 500 ? "..." : ""}\`\`\``, inline: false },
    )
    .setTimestamp();

  return embed;
}

/**
 * Build the channel selector dropdown for the main dashboard.
 */
export function buildChannelSelector(client: Client, guildId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const guild = client.guilds.cache.get(guildId);
  const channels = guild?.channels.cache
    .filter((ch): ch is TextChannel => ch.type === ChannelType.GuildText)
    .sort((a: TextChannel, b: TextChannel) => a.name.localeCompare(b.name));

  const select = new StringSelectMenuBuilder()
    .setCustomId("dashboard:select-channel")
    .setPlaceholder("Sélectionne un channel à configurer...")
    .setMinValues(1)
    .setMaxValues(1);

  if (channels) {
    const options = Array.from(channels.values()).slice(0, 25).map(ch => ({
      label: `#${ch.name}`.slice(0, 100),
      value: `${ch.id}|${ch.name}`,
      description: `Configurer #${ch.name}`.slice(0, 100),
    }));
    select.addOptions(options);
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Build action buttons for a channel detail view.
 */
export function buildChannelActionRows(channelId: string, channelName: string): ActionRowBuilder<ButtonBuilder>[] {
  // Row 1: Edit actions
  const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-model|${channelId}|${channelName}`)
      .setLabel("Model")
      .setEmoji("🤖")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-maxturns|${channelId}|${channelName}`)
      .setLabel("Max turns")
      .setEmoji("🔢")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-compact|${channelId}|${channelName}`)
      .setLabel("Compaction")
      .setEmoji("🧠")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-streaming|${channelId}|${channelName}`)
      .setLabel("Streaming")
      .setEmoji("📡")
      .setStyle(ButtonStyle.Primary),
  );

  // Row 2: Text inputs (modals)
  const textRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-prompt|${channelId}|${channelName}`)
      .setLabel("System prompt")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`dashboard:edit-dir|${channelId}|${channelName}`)
      .setLabel("Project dir")
      .setEmoji("📁")
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 3: Reset + back
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dashboard:reset|${channelId}|${channelName}`)
      .setLabel("Reset overrides")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("dashboard:back")
      .setLabel("Retour")
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Secondary),
  );

  return [editRow, textRow, navRow];
}

/**
 * Build the model selector dropdown (shown after clicking "Model" button).
 */
export function buildModelSelector(channelName: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`dashboard:set-model|${channelName}`)
    .setPlaceholder("Choisis un modèle...")
    .addOptions([
      { label: "Opus", value: "opus", description: "Le plus puissant — pour le code complexe", emoji: "🔴" },
      { label: "Sonnet", value: "sonnet", description: "Équilibré — pour l'analyse et la génération", emoji: "🟡" },
      { label: "Haiku", value: "haiku", description: "Le plus rapide — pour les tâches simples", emoji: "🟢" },
    ]);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Build the streaming toggle dropdown.
 */
export function buildStreamingSelector(channelName: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`dashboard:set-streaming|${channelName}`)
    .setPlaceholder("Streaming ?")
    .addOptions([
      { label: "Activé", value: "1", description: "Affiche le texte en temps réel", emoji: "✅" },
      { label: "Désactivé", value: "0", description: "Ne montre que le résultat final", emoji: "❌" },
    ]);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Build a modal for numeric input (max-turns, compact-threshold).
 */
export function buildNumericModal(field: "maxturns" | "compact", channelName: string, currentValue: number): ModalBuilder {
  const labels = {
    maxturns: { title: "Max turns", label: "Nombre max de tours par session", placeholder: "0 = illimité" },
    compact: { title: "Compaction threshold", label: "Compacter après N messages", placeholder: "ex: 40" },
  };
  const cfg = labels[field];

  return new ModalBuilder()
    .setCustomId(`dashboard:modal-${field}|${channelName}`)
    .setTitle(`${cfg.title} — #${channelName}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(cfg.label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(cfg.placeholder)
          .setValue(String(currentValue))
          .setRequired(true)
          .setMaxLength(6),
      ),
    );
}

/**
 * Build a modal for text input (system prompt, project dir).
 */
export function buildTextModal(field: "prompt" | "dir", channelName: string, currentValue: string): ModalBuilder {
  const labels = {
    prompt: { title: "System prompt", label: "Prompt système", style: TextInputStyle.Paragraph, max: 4000 },
    dir: { title: "Project directory", label: "Chemin du projet", style: TextInputStyle.Short, max: 500 },
  };
  const cfg = labels[field];

  return new ModalBuilder()
    .setCustomId(`dashboard:modal-${field}|${channelName}`)
    .setTitle(`${cfg.title} — #${channelName}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(cfg.label)
          .setStyle(cfg.style)
          .setValue(currentValue.slice(0, cfg.max))
          .setRequired(true)
          .setMaxLength(cfg.max),
      ),
    );
}

/**
 * Handle a button interaction from the dashboard.
 * Returns true if the interaction was handled.
 */
export async function handleDashboardButton(
  interaction: ButtonInteraction,
  client: Client,
  guildId: string,
): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("dashboard:")) return false;

  const [action, channelId, channelName] = customId.replace("dashboard:", "").split("|");

  switch (action) {
    case "back": {
      await interaction.update({
        embeds: [buildDashboardEmbed(client, guildId)],
        components: [buildChannelSelector(client, guildId)],
      });
      return true;
    }

    case "edit-model": {
      await interaction.update({
        embeds: [buildChannelDetailEmbed(channelId, channelName)],
        components: [buildModelSelector(channelName), ...buildChannelActionRows(channelId, channelName)],
      });
      return true;
    }

    case "edit-streaming": {
      await interaction.update({
        embeds: [buildChannelDetailEmbed(channelId, channelName)],
        components: [buildStreamingSelector(channelName), ...buildChannelActionRows(channelId, channelName)],
      });
      return true;
    }

    case "edit-maxturns": {
      const config = getChannelConfig(channelId, channelName);
      await interaction.showModal(buildNumericModal("maxturns", channelName, config.maxTurns));
      return true;
    }

    case "edit-compact": {
      const config = getChannelConfig(channelId, channelName);
      await interaction.showModal(buildNumericModal("compact", channelName, config.compactThreshold));
      return true;
    }

    case "edit-prompt": {
      const config = getChannelConfig(channelId, channelName);
      await interaction.showModal(buildTextModal("prompt", channelName, config.systemPrompt));
      return true;
    }

    case "edit-dir": {
      const config = getChannelConfig(channelId, channelName);
      await interaction.showModal(buildTextModal("dir", channelName, config.projectDir));
      return true;
    }

    case "reset": {
      deleteChannelSetting(channelName);
      await interaction.update({
        embeds: [buildChannelDetailEmbed(channelId, channelName).setDescription("✅ **Overrides supprimés** — retour aux valeurs par défaut.")],
        components: buildChannelActionRows(channelId, channelName),
      });
      return true;
    }

    default:
      return false;
  }
}

/**
 * Handle a select menu interaction.
 */
export async function handleDashboardSelect(
  interaction: StringSelectMenuInteraction,
  client: Client,
  guildId: string,
): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("dashboard:")) return false;

  const [action, channelName] = customId.replace("dashboard:", "").split("|");
  const value = interaction.values[0];

  switch (action) {
    case "select-channel": {
      const [chId, chName] = value.split("|");
      await interaction.update({
        embeds: [buildChannelDetailEmbed(chId, chName)],
        components: buildChannelActionRows(chId, chName),
      });
      return true;
    }

    case "set-model": {
      upsertChannelSetting(channelName, { model: value });
      const guild = client.guilds.cache.get(guildId);
      const ch = guild?.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === channelName) as TextChannel | undefined;
      if (ch) {
        await interaction.update({
          embeds: [buildChannelDetailEmbed(ch.id, channelName).setDescription(`✅ Model défini à \`${value}\``)],
          components: buildChannelActionRows(ch.id, channelName),
        });
      }
      return true;
    }

    case "set-streaming": {
      upsertChannelSetting(channelName, { streaming: parseInt(value) });
      const guild = client.guilds.cache.get(guildId);
      const ch = guild?.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === channelName) as TextChannel | undefined;
      if (ch) {
        await interaction.update({
          embeds: [buildChannelDetailEmbed(ch.id, channelName).setDescription(`✅ Streaming ${value === "1" ? "activé" : "désactivé"}`)],
          components: buildChannelActionRows(ch.id, channelName),
        });
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Handle a modal submit interaction.
 */
export async function handleDashboardModal(
  interaction: ModalSubmitInteraction,
  client: Client,
  guildId: string,
): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith("dashboard:")) return false;

  const [action, channelName] = customId.replace("dashboard:", "").split("|");
  const value = interaction.fields.getTextInputValue("value");

  const guild = client.guilds.cache.get(guildId);
  const ch = guild?.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === channelName) as TextChannel | undefined;
  if (!ch) {
    await interaction.reply({ content: `❌ Channel #${channelName} introuvable.`, ephemeral: true });
    return true;
  }

  // Helper to update the original message after a modal submit
  const updateOriginal = async (description: string) => {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [buildChannelDetailEmbed(ch.id, channelName).setDescription(description)],
      components: buildChannelActionRows(ch.id, channelName),
    });
  };

  switch (action) {
    case "modal-maxturns": {
      const num = parseInt(value);
      if (isNaN(num) || num < 0) {
        await interaction.reply({ content: "❌ Valeur invalide. Doit être un entier ≥ 0.", ephemeral: true });
        return true;
      }
      upsertChannelSetting(channelName, { max_turns: num });
      await updateOriginal(`✅ Max turns défini à \`${num}\``);
      return true;
    }

    case "modal-compact": {
      const num = parseInt(value);
      if (isNaN(num) || num < 5) {
        await interaction.reply({ content: "❌ Valeur invalide. Doit être un entier ≥ 5.", ephemeral: true });
        return true;
      }
      upsertChannelSetting(channelName, { compact_threshold: num });
      await updateOriginal(`✅ Compaction définie à \`${num} messages\``);
      return true;
    }

    case "modal-prompt": {
      upsertChannelSetting(channelName, { system_prompt: value });
      await updateOriginal(`✅ System prompt mis à jour (${value.length} caractères)`);
      return true;
    }

    case "modal-dir": {
      upsertChannelSetting(channelName, { project_dir: value });
      await updateOriginal(`✅ Project dir défini à \`${value}\``);
      return true;
    }

    default:
      return false;
  }
}
