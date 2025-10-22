import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { collections } from './firebase.js';

let client = null;
let targetChannelId = null;

/**
 * Initialize Discord bot client
 */
export function initializeDiscordBot() {
  return new Promise((resolve, reject) => {
    try {
      targetChannelId = process.env.DISCORD_CHANNEL_ID;
      
      if (!targetChannelId) {
        throw new Error('DISCORD_CHANNEL_ID environment variable not set');
      }

      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
      });

      // Bot ready event
      client.once(Events.ClientReady, () => {
        console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
        resolve(client);
      });

      // Login with bot token
      client.login(process.env.DISCORD_TOKEN);

    } catch (error) {
      console.error('❌ Error initializing Discord bot:', error.message);
      reject(error);
    }
  });
}

/**
 * Post a message to the configured Discord channel
 * @param {Object} postData - The post data from Firestore
 * @returns {Promise<Object>} - Discord message object with metadata
 */
export async function postToDiscord(postData) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel) {
      throw new Error(`Could not find channel with ID: ${targetChannelId}`);
    }

    // Create the message content
    const messageContent = formatPostMessage(postData);

    // Send the message
    const message = await channel.send(messageContent);

    // Add the ✅ reaction automatically
    await message.react('✅');

    console.log(`📤 Posted message to Discord: ${message.id}`);

    // Return message metadata
    return {
      messageId: message.id,
      channelId: message.channel.id,
      timestamp: message.createdTimestamp,
      url: message.url
    };

  } catch (error) {
    console.error('❌ Error posting to Discord:', error.message);
    throw error;
  }
}

/**
 * Update an existing Discord message
 * @param {string} messageId - Discord message ID
 * @param {Object} updatedData - Updated post data
 */
export async function updateDiscordMessage(messageId, updatedData) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    const channel = await client.channels.fetch(targetChannelId);
    const message = await channel.messages.fetch(messageId);

    if (!message) {
      throw new Error(`Could not find message with ID: ${messageId}`);
    }

    const updatedContent = formatPostMessage(updatedData);
    await message.edit(updatedContent);

    console.log(`📝 Updated Discord message: ${messageId}`);
    return message;

  } catch (error) {
    console.error('❌ Error updating Discord message:', error.message);
    throw error;
  }
}

/**
 * Format post data into Discord message content
 * @param {Object} postData - Post data from Firestore
 * @returns {string} - Formatted message content
 */
function formatPostMessage(postData) {
  const {
    title = 'New Post',
    description = '',
    author = 'Anonymous',
    timestamp,
    reactions = {},
    additionalInfo = ''
  } = postData;

  let message = `**${title}**\n`;
  
  if (description) {
    message += `${description}\n`;
  }
  
  message += `\n*Posted by: ${author}*`;
  
  if (timestamp) {
    message += `\n*Time: ${new Date(timestamp).toLocaleString()}*`;
  }

  // Add reaction count if there are reactions
  const reactionCount = reactions['✅'] || 0;
  if (reactionCount > 0) {
    message += `\n\n✅ **${reactionCount}** people have reacted`;
  }

  // Add additional info if provided
  if (additionalInfo) {
    message += `\n\n**Update:**\n${additionalInfo}`;
  }

  return message;
}

/**
 * Get Discord client instance
 */
export function getDiscordClient() {
  return client;
}

/**
 * Get target channel ID
 */
export function getTargetChannelId() {
  return targetChannelId;
}

export default {
  initializeDiscordBot,
  postToDiscord,
  updateDiscordMessage,
  getDiscordClient,
  getTargetChannelId
};