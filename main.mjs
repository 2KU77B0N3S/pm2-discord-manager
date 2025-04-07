import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import dotenv from 'dotenv';
import pm2 from 'pm2';
import { promisify } from 'util';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const PM2_CHANNEL_ID = process.env.PM2_CHANNEL_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Promisify PM2 functions for async/await usage
const connectPM2 = promisify(pm2.connect.bind(pm2));
const listPM2 = promisify(pm2.list.bind(pm2));
const startPM2 = promisify(pm2.start.bind(pm2));
const stopPM2 = promisify(pm2.stop.bind(pm2));
const restartPM2 = promisify(pm2.restart.bind(pm2));

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('pm2')
    .setDescription('Manage PM2 processes')
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('List all PM2 processes')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('Start a PM2 process')
        .addStringOption((option) =>
          option
            .setName('process')
            .setDescription('The name or ID of the process to start')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stop')
        .setDescription('Stop a PM2 process')
        .addStringOption((option) =>
          option
            .setName('process')
            .setDescription('The name or ID of the process to stop')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('restart')
        .setDescription('Restart a PM2 process')
        .addStringOption((option) =>
          option
            .setName('process')
            .setDescription('The name or ID of the process to restart')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('restartall').setDescription('Restart all PM2 processes')
    ),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

/**
 * Registers guild-specific slash commands with Discord.
 */
async function registerGuildCommands() {
  try {
    console.log('Registering guild-specific commands...');
    const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log(`Successfully registered ${data.length} guild-specific command(s).`);
  } catch (error) {
    console.error('Error registering guild commands:', error);
  }
}

// Initial setup for commands
(async () => {
  console.log('Starting command setup...');
  await registerGuildCommands();
  console.log('Command setup completed.');
})();

/**
 * Creates an embed containing the current PM2 process list.
 * @returns {EmbedBuilder} The constructed embed with process details.
 */
async function createPm2ListEmbed() {
  await connectPM2();
  const processes = await listPM2();
  pm2.disconnect();

  const embed = new EmbedBuilder()
    .setTitle('Current PM2 Processes')
    .setColor(0x0099ff)
    .setDescription(
      processes
        .map(
          (p) => `**ID:** ${p.pm_id} | **Name:** ${p.name} | **Status:** \`${p.pm2_env.status}\``
        )
        .join('\n') || 'No processes running.'
    )
    .setTimestamp(new Date());

  return embed;
}

// Store reference to the single embed message
let pm2ListMessage = null;

/**
 * Sends or updates the PM2 process list embed in the specified channel.
 * @param {TextChannel} channel The Discord channel to send/update the embed in.
 */
async function sendOrUpdatePm2ListEmbed(channel) {
  const embed = await createPm2ListEmbed();

  if (!pm2ListMessage) {
    const manageButton = new ButtonBuilder()
      .setCustomId('managePm2')
      .setLabel('Manage PM2')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(manageButton);

    pm2ListMessage = await channel.send({
      embeds: [embed],
      components: [row],
    });
  } else {
    await pm2ListMessage.edit({
      embeds: [embed],
      components: pm2ListMessage.components,
    });
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const pm2Channel = await client.channels.fetch(PM2_CHANNEL_ID);
  if (!pm2Channel || !pm2Channel.isTextBased()) {
    console.error('PM2_CHANNEL_ID is invalid or not a text channel.');
    return;
  }

  // Clear the channel and send the initial embed
  await clearChannel(pm2Channel);
  await sendOrUpdatePm2ListEmbed(pm2Channel);

  // Update the embed every 30 seconds
  setInterval(async () => {
    try {
      await sendOrUpdatePm2ListEmbed(pm2Channel);
    } catch (error) {
      console.error('Error updating PM2 list:', error);
    }
  }, 30000);
});

/**
 * Clears all messages in the specified channel.
 * Note: Discord only allows bulk deletion of messages newer than 14 days.
 * @param {TextChannel} channel The channel to clear.
 */
async function clearChannel(channel) {
  try {
    let messages;
    do {
      messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size > 0) {
        await channel.bulkDelete(messages, true);
        console.log(`Deleted ${messages.size} messages in ${channel.name}`);
      }
    } while (messages.size >= 2);
  } catch (error) {
    console.error(`Error clearing channel ${channel.name}:`, error);
  }
}

client.on('interactionCreate', async (interaction) => {
  // Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    if (interaction.channelId !== PM2_CHANNEL_ID) {
      return interaction.reply({
        content: 'This command can only be used in the PM2 management channel.',
        ephemeral: true,
      });
    }

    const { commandName, options } = interaction;
    if (commandName === 'pm2') {
      const subcommand = options.getSubcommand();
      try {
        await connectPM2();
        switch (subcommand) {
          case 'list':
            await handleList(interaction);
            break;
          case 'start':
            await handleStart(interaction);
            break;
          case 'stop':
            await handleStop(interaction);
            break;
          case 'restart':
            await handleRestart(interaction);
            break;
          case 'restartall':
            await handleRestartAll(interaction);
            break;
        }
        pm2.disconnect();
      } catch (error) {
        console.error('Error:', error);
        await interaction.reply({
          content: 'An error occurred.',
          ephemeral: true,
        });
      }
    }
  }

  // Handle "Manage PM2" Button -> Dropdown with Pagination
  if (interaction.isButton() && interaction.customId === 'managePm2') {
    try {
      await connectPM2();
      const processes = await listPM2();
      pm2.disconnect();

      const itemsPerPage = 25;
      const totalPages = Math.ceil(processes.length / itemsPerPage);
      const page = 0;

      const paginatedOptions = getPaginatedOptions(processes, page, itemsPerPage);
      const selectMenu = createSelectMenu(paginatedOptions, 'pm2Select');

      const prevButton = new ButtonBuilder()
        .setCustomId('prevPage_pm2')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

      const nextButton = new ButtonBuilder()
        .setCustomId('nextPage_pm2')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPages <= 1);

      const row = new ActionRowBuilder().addComponents(selectMenu);
      const navRow = new ActionRowBuilder().addComponents(prevButton, nextButton);

      await interaction.reply({
        content: `Select a process (Page ${page + 1}/${totalPages}):`,
        components: [row, navRow],
        ephemeral: true,
      });
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: 'Error loading process list.',
        ephemeral: true,
      });
    }
  }

  // Handle Pagination Navigation
  if (
    interaction.isButton() &&
    (interaction.customId === 'prevPage_pm2' || interaction.customId === 'nextPage_pm2')
  ) {
    try {
      await connectPM2();
      const processes = await listPM2();
      pm2.disconnect();

      const itemsPerPage = 25;
      const totalPages = Math.ceil(processes.length / itemsPerPage);
      let page = parseInt(interaction.message.content.match(/Page (\d+)/)[1]) - 1;

      if (interaction.customId === 'nextPage_pm2') {
        page = Math.min(page + 1, totalPages - 1);
      } else if (interaction.customId === 'prevPage_pm2') {
        page = Math.max(page - 1, 0);
      }

      const paginatedOptions = getPaginatedOptions(processes, page, itemsPerPage);
      const selectMenu = createSelectMenu(paginatedOptions, 'pm2Select');

      const prevButton = new ButtonBuilder()
        .setCustomId('prevPage_pm2')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

      const nextButton = new ButtonBuilder()
        .setCustomId('nextPage_pm2')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages - 1);

      const row = new ActionRowBuilder().addComponents(selectMenu);
      const navRow = new ActionRowBuilder().addComponents(prevButton, nextButton);

      await interaction.update({
        content: `Select a process (Page ${page + 1}/${totalPages}):`,
        components: [row, navRow],
      });
    } catch (error) {
      console.error(error);
      await interaction.followUp({
        content: 'Error navigating pages.',
        ephemeral: true,
      });
    }
  }

  // Handle Select Menu -> Show Start/Stop/Restart Buttons
  if (interaction.isStringSelectMenu() && interaction.customId === 'pm2Select') {
    const processId = interaction.values[0];

    const startBtn = new ButtonBuilder()
      .setCustomId(`pm2Start_${processId}`)
      .setLabel('Start')
      .setStyle(ButtonStyle.Success);

    const stopBtn = new ButtonBuilder()
      .setCustomId(`pm2Stop_${processId}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger);

    const restartBtn = new ButtonBuilder()
      .setCustomId(`pm2Restart_${processId}`)
      .setLabel('Restart')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(startBtn, stopBtn, restartBtn);

    await interaction.reply({
      content: `You selected process ID **${processId}**. What would you like to do?`,
      components: [row],
      ephemeral: true,
    });
  }

  // Handle Start/Stop/Restart Buttons
  if (interaction.isButton() && interaction.customId.startsWith('pm2')) {
    const [action, processId] = interaction.customId.split('_');
    if (!processId) return;

    await interaction.deferUpdate();
    try {
      await connectPM2();
      if (action === 'pm2Start') {
        await startPM2(processId);
        await interaction.followUp({
          ephemeral: true,
          content: `Process **${processId}** has been started.`,
        });
      } else if (action === 'pm2Stop') {
        await stopPM2(processId);
        await interaction.followUp({
          ephemeral: true,
          content: `Process **${processId}** has been stopped.`,
        });
      } else if (action === 'pm2Restart') {
        await restartPM2(processId);
        await interaction.followUp({
          ephemeral: true,
          content: `Process **${processId}** has been restarted.`,
        });
      }
      pm2.disconnect();
    } catch (err) {
      console.error(err);
      await interaction.followUp({
        ephemeral: true,
        content: `Error performing action on process ${processId}.`,
      });
    }
  }
});

/**
 * Generates paginated options for the select menu.
 * @param {Array} processes List of PM2 processes.
 * @param {number} page Current page number (0-based).
 * @param {number} itemsPerPage Number of items per page.
 * @returns {StringSelectMenuOptionBuilder[]} Paginated options.
 */
function getPaginatedOptions(processes, page, itemsPerPage) {
  const start = page * itemsPerPage;
  const end = start + itemsPerPage;
  return processes.slice(start, end).map((p) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`ID: ${p.pm_id} - ${p.name}`)
      .setValue(p.pm_id.toString())
  );
}

/**
 * Creates a select menu with the provided options.
 * @param {StringSelectMenuOptionBuilder[]} options Options for the menu.
 * @param {string} customId Custom ID for the menu.
 * @returns {StringSelectMenuBuilder} The constructed select menu.
 */
function createSelectMenu(options, customId) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select a process')
    .addOptions(options);
}

/**
 * Handles the 'list' subcommand.
 * @param {CommandInteraction} interaction The Discord interaction.
 */
async function handleList(interaction) {
  await interaction.deferReply();
  const processList = await listPM2();
  const embed = new EmbedBuilder()
    .setTitle('PM2 Process List')
    .setColor(0x0099ff)
    .setDescription(
      processList.map((p) => `ID: ${p.pm_id} | Name: ${p.name}`).join('\n') || 'No processes found.'
    );
  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handles the 'start' subcommand.
 * @param {CommandInteraction} interaction The Discord interaction.
 */
async function handleStart(interaction) {
  const process = interaction.options.getString('process');
  await interaction.deferReply();
  await startPM2(process);
  await interaction.editReply(`Process ${process} has been started.`);
}

/**
 * Handles the 'stop' subcommand.
 * @param {CommandInteraction} interaction The Discord interaction.
 */
async function handleStop(interaction) {
  const process = interaction.options.getString('process');
  await interaction.deferReply();
  await stopPM2(process);
  await interaction.editReply(`Process ${process} has been stopped.`);
}

/**
 * Handles the 'restart' subcommand.
 * @param {CommandInteraction} interaction The Discord interaction.
 */
async function handleRestart(interaction) {
  const process = interaction.options.getString('process');
  await interaction.deferReply();
  await restartPM2(process);
  await interaction.editReply(`Process ${process} has been restarted.`);
}

/**
 * Handles the 'restartall' subcommand.
 * @param {CommandInteraction} interaction The Discord interaction.
 */
async function handleRestartAll(interaction) {
  await interaction.deferReply();
  await restartPM2('all');
  await interaction.editReply('All PM2 processes have been restarted.');
}

client.login(TOKEN);
