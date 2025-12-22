import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { collections } from './firebase.js';
import { getDiscordChannelId, isAutoPostingEnabled } from './guildSettings.js';

let client = null;
let defaultChannelId = null;

/**
 * Initialize Discord bot client
 */
export function initializeDiscordBot() {
  return new Promise((resolve, reject) => {
    try {
      defaultChannelId = process.env.DISCORD_CHANNEL_ID;
      
      if (!defaultChannelId) {
        console.warn('⚠️ DISCORD_CHANNEL_ID environment variable not set, will use guild-specific channels');
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
        console.log(`📊 Connected to ${client.guilds.cache.size} Discord server(s):`);
        client.guilds.cache.forEach(guild => {
          console.log(`   🏰 ${guild.name} (ID: ${guild.id}) - ${guild.memberCount} members`);
          console.log(`      📺 Available text channels:`);
          guild.channels.cache
            .filter(channel => channel.type === 0) // Text channels
            .forEach(channel => {
              console.log(`         #${channel.name} (ID: ${channel.id})`);
            });
        });
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
 * Post a message to the configured Discord channel for a specific guild
 * @param {Object} postData - The post data from Firestore
 * @param {string} guildId - Guild ID to determine channel
 * @returns {Promise<Object>} - Discord message object with metadata
 */
export async function postToDiscord(postData, guildId) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    // Get guild-specific channel for events
    const channelId = await getDiscordChannelId(guildId, 'events');
    
    if (!channelId) {
      throw new Error(`No events channel configured for guild: ${guildId}`);
    }

    console.log(`📤 Posting to Discord for guild: ${guildId}`);
    console.log(`   📺 Channel ID: ${channelId}`);

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Could not find channel with ID: ${channelId}`);
    }
    
    console.log(`   ✅ Channel found: ${channel.name} (${channel.guild?.name || 'Unknown Server'})`);

    // Check if auto posting is enabled for this guild
    const autoPostEnabled = await isAutoPostingEnabled(guildId, 'events');
    if (!autoPostEnabled) {
      console.log(`⚠️ Auto event posting disabled for guild ${guildId}, skipping post`);
      return null;
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
 * @param {string} guildId - Guild ID to determine channel
 */
export async function updateDiscordMessage(messageId, updatedData, guildId) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    // Get guild-specific channel for events
    const channelId = await getDiscordChannelId(guildId, 'events');
    
    if (!channelId) {
      throw new Error(`No events channel configured for guild: ${guildId}`);
    }

    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);

    if (!message) {
      throw new Error(`Could not find message with ID: ${messageId}`);
    }

    const updatedContent = formatPostMessage(updatedData);
    await message.edit(updatedContent);

    console.log(`📝 Updated Discord message: ${messageId} for guild ${guildId}`);
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
    additionalInfo = '',
    roamId = null,
    roamDetails = null
  } = postData;

  let message = `**${title}**\n`;
  
  if (description) {
    message += `${description}\n`;
  }
  
  // Add roam information if available
  if (roamId && roamDetails) {
    message += `\n🗡️ **Roam ID:** ${roamId}`;
    if (roamDetails.type) message += `\n📋 **Type:** ${roamDetails.type}`;
    if (roamDetails.datetime) message += `\n⏰ **Time:** ${roamDetails.datetime}`;
    if (roamDetails.leader) message += `\n👑 **Leader:** ${roamDetails.leader}`;
    if (roamDetails.description) message += `\n📝 **Details:** ${roamDetails.description}`;
  } else if (roamId) {
    message += `\n🗡️ **Roam ID:** ${roamId}`;
  }
  
  message += `\n\n*Posted by: ${author}*`;
  
  if (timestamp) {
    message += `\n*Time: ${new Date(timestamp).toLocaleString()}*`;
  }

  // Add reaction count if there are reactions
  const reactionCount = reactions['✅'] || 0;
  if (reactionCount > 0) {
    message += `\n\n✅ **${reactionCount}** people signed up`;
  } else {
    message += `\n\n✅ React to sign up for this roam!`;
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

export default {
  initializeDiscordBot,
  postToDiscord,
  updateDiscordMessage,
  getDiscordClient
};