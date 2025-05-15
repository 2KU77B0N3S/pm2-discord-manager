import pkg from 'discord.js';
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags
} = pkg;
import dotenv from 'dotenv';
import pm2 from 'pm2';
import { promisify } from 'util';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const PM2_CHANNEL_ID = process.env.PM2_CHANNEL_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const connectPM2 = promisify(pm2.connect.bind(pm2));
const listPM2 = promisify(pm2.list.bind(pm2));
const startPM2 = promisify(pm2.start.bind(pm2));
const stopPM2 = promisify(pm2.stop.bind(pm2));
const restartPM2 = promisify(pm2.restart.bind(pm2));

async function safeReply(interaction, options) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(options);
    } else {
      return await interaction.reply(options);
    }
  } catch (error) {
    console.error('Error sending response:', error);
  }
}

async function createPm2ListEmbed() {
  await connectPM2();
  const processes = await listPM2();
  pm2.disconnect();

  return new EmbedBuilder()
    .setTitle('Current PM2 Processes')
    .setColor(0x0099FF)
    .setDescription(processes.map(p =>
      `**ID:** ${p.pm_id} | **Name:** ${p.name} | **Status:** \`${p.pm2_env.status}\``).join('\n'))
    .setTimestamp(new Date());
}

let pm2ListMessage = null;

async function sendOrUpdatePm2ListEmbed(channel) {
  const embed = await createPm2ListEmbed();

  const manageButton = new ButtonBuilder()
    .setCustomId('pm2_manage')
    .setLabel('Manage PM2')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(manageButton);

  if (!pm2ListMessage) {
    pm2ListMessage = await channel.send({ embeds: [embed], components: [row] });
  } else {
    await pm2ListMessage.edit({ embeds: [embed], components: [row] });
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const pm2Channel = await client.channels.fetch(PM2_CHANNEL_ID);

  if (!pm2Channel || !pm2Channel.isTextBased()) {
    console.error('PM2_CHANNEL_ID is invalid or not a text channel.');
    return;
  }

  await clearChannel(pm2Channel);
  await sendOrUpdatePm2ListEmbed(pm2Channel);

  setInterval(async () => {
    try {
      await sendOrUpdatePm2ListEmbed(pm2Channel);
    } catch (error) {
      console.error('Error updating PM2 list:', error);
    }
  }, 30000);
});

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

client.on('interactionCreate', async interaction => {
  const startTime = Date.now();
  try {
    if (interaction.replied || interaction.deferred) {
      console.log(`Interaction already responded (customId: ${interaction.customId || 'N/A'}, user: ${interaction.user.id})`);
      return;
    }

    console.log(`Interaction received: customId=${interaction.customId || 'N/A'}, user=${interaction.user.id}, type=${interaction.type}`);

    if (interaction.isButton()) {
      if (interaction.customId === 'pm2_manage') {
        try {
          await connectPM2();
          const processes = await listPM2();
          pm2.disconnect();

          const chunkSize = 25;
          const processChunks = [];
          for (let i = 0; i < processes.length; i += chunkSize) {
            processChunks.push(processes.slice(i, i + chunkSize));
          }

          const rows = processChunks.map((chunk, index) => {
            const menuOptions = chunk.map(p =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`ID: ${p.pm_id} - ${p.name}`)
                .setValue(p.pm_id.toString())
            );

            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`pm2_select_${index}`)
              .setPlaceholder(`Processes ${index * chunkSize + 1}-${Math.min((index + 1) * chunkSize, processes.length)}`)
              .addOptions(menuOptions);

            return new ActionRowBuilder().addComponents(selectMenu);
          });

          await safeReply(interaction, {
            content: 'Select a process:',
            components: rows,
            flags: MessageFlags.Ephemeral
          });
          console.log(`PM2 Manage-Button processed in ${Date.now() - startTime}ms`);
        } catch (error) {
          console.error('Error loading process list:', error);
          await safeReply(interaction, {
            content: 'Error loading process list.',
            flags: MessageFlags.Ephemeral
          });
        }
        return;
      }

      if (interaction.customId.startsWith('pm2_')) {
        const parts = interaction.customId.split('_');
        if (parts.length !== 3) {
          console.log(`Invalid customId format: ${interaction.customId}`);
          await safeReply(interaction, {
            content: 'Invalid action. Please try again.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const [, action, processId] = parts;

        await interaction.deferUpdate();
        try {
          await connectPM2();
          if (action === 'start') {
            await startPM2(processId);
            console.log(`PM2 Process ${processId} started`);
          } else if (action === 'stop') {
            await stopPM2(processId);
            console.log(`PM2 Process ${processId} stopped`);
          } else if (action === 'restart') {
            await restartPM2(processId);
            console.log(`PM2 Process ${processId} restarted`);
          } else {
            throw new Error(`Unknown action: ${action}`);
          }
          pm2.disconnect();

          await interaction.followUp({
            content: `Process **${processId}** has been ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}.`,
            flags: MessageFlags.Ephemeral
          });
          console.log(`PM2 Action ${action} for process ${processId} successful in ${Date.now() - startTime}ms`);
        } catch (error) {
          console.error(`Error during PM2 action ${action} for process ${processId}:`, error);
          await interaction.followUp({
            content: `Error during action ${action} for process ${processId}: ${error.message}`,
            flags: MessageFlags.Ephemeral
          });
          pm2.disconnect();
        }
        return;
      }

      console.log(`Unknown button (customId: ${interaction.customId}) ignored in ${Date.now() - startTime}ms`);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('pm2_select')) {
        const processId = interaction.values[0];

        const startBtn = new ButtonBuilder()
          .setCustomId(`pm2_start_${processId}`)
          .setLabel('Start')
          .setStyle(ButtonStyle.Success);

        const stopBtn = new ButtonBuilder()
          .setCustomId(`pm2_stop_${processId}`)
          .setLabel('Stop')
          .setStyle(ButtonStyle.Danger);

        const restartBtn = new ButtonBuilder()
          .setCustomId(`pm2_restart_${processId}`)
          .setLabel('Restart')
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(startBtn, stopBtn, restartBtn);

        await safeReply(interaction, {
          content: `You selected Process-ID **${processId}**. What would you like to do?`,
          components: [row],
          flags: MessageFlags.Ephemeral
        });
        console.log(`PM2 Select-Menu processed in ${Date.now() - startTime}ms`);
        return;
      }

      console.log(`Unknown Select-Menu (customId: ${interaction.customId}) ignored in ${Date.now() - startTime}ms`);
      return;
    }

    console.log(`Unknown interaction type (${interaction.type}) ignored in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error(`Error processing interaction (Duration: ${Date.now() - startTime}ms, customId: ${interaction.customId || 'N/A'}, user: ${interaction.user.id}):`, error);
    if (!interaction.isRepliable()) {
      console.log('Interaction no longer replyable');
      return;
    }
    try {
      await safeReply(interaction, {
        content: 'There was an issue processing the request. Please try again later.',
        flags: MessageFlags.Ephemeral
      });
    } catch (replyError) {
      console.error('Error sending error response:', replyError);
    }
  }
});

client.login(TOKEN);
