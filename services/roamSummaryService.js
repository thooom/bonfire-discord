import { getDiscordChannelId, isAutoPostingEnabled } from './guildSettings.js';

/**
 * Post a roam summary to Discord's logs channel
 * @param {Object} postData - The roam summary data from Firestore
 * @param {string} guildId - Guild ID to determine channel
 * @param {Object} client - Discord client instance
 * @returns {Promise<Object>} - Discord message object with metadata (or null if auto-posting disabled)
 */
export async function postRoamSummary(postData, guildId, client) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    // Check if auto posting is enabled for this guild
    const autoPostEnabled = await isAutoPostingEnabled(guildId, 'logs');
    if (!autoPostEnabled) {
      console.log(
        `⚠️ Auto log posting disabled for guild ${guildId}, skipping roam summary`,
      );
      return null;
    }

    // Get guild-specific logs channel
    const channelId = await getDiscordChannelId(guildId, 'logs');
    
    if (!channelId) {
      throw new Error(`No logs channel configured for guild: ${guildId}`);
    }

    console.log(`📊 Posting roam summary to Discord for guild: ${guildId}`);
    console.log(`   📝 Logs Channel ID: ${channelId}`);

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Could not find logs channel with ID: ${channelId}`);
    }
    
    console.log(`   ✅ Channel found: ${channel.name} (${channel.guild?.name || 'Unknown Server'})`);

    // Format the roam summary message
    const messageContent = formatRoamSummary(postData);

    // Send the message
    const message = await channel.send(messageContent);

    console.log(`📊 Roam summary posted to Discord: ${message.id}`);

    // Return message metadata
    return {
      messageId: message.id,
      channelId: message.channel.id,
      timestamp: message.createdTimestamp,
      url: message.url
    };

  } catch (error) {
    console.error('❌ Error posting roam summary to Discord:', error.message);
    throw error;
  }
}

/**
 * Format a roam summary for Discord
 * @param {Object} postData - The roam summary data
 * @returns {Object} - Discord message options with embeds
 */
function formatRoamSummary(postData) {
  const { title, description } = postData;

  // Create embed - description already contains the formatted participant list
  const embed = {
    title: title || '📊 Roam Summary',
    description: description || 'No details available',
    color: 0x5865F2, // Discord blurple color
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Roam Summary'
    }
  };

  return {
    embeds: [embed]
  };
}

/**
 * Update an existing roam summary message in Discord
 * @param {string} messageId - Discord message ID
 * @param {Object} updatedData - Updated roam summary data
 * @param {string} guildId - Guild ID to determine channel
 * @param {Object} client - Discord client instance
 */
export async function updateRoamSummary(messageId, updatedData, guildId, client) {
  try {
    if (!client || !client.isReady()) {
      throw new Error('Discord bot is not ready');
    }

    // Get guild-specific logs channel
    const channelId = await getDiscordChannelId(guildId, 'logs');
    
    if (!channelId) {
      throw new Error(`No logs channel configured for guild: ${guildId}`);
    }

    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);

    if (!message) {
      throw new Error(`Could not find message with ID: ${messageId}`);
    }

    const updatedContent = formatRoamSummary(updatedData);
    await message.edit(updatedContent);

    console.log(`📝 Updated roam summary in Discord: ${messageId} for guild ${guildId}`);
    return message;

  } catch (error) {
    console.error('❌ Error updating roam summary:', error.message);
    throw error;
  }
}
