import { collections } from './firebase.js';

/**
 * Guild settings management service
 */

/**
 * Get guild settings and configuration
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} - Guild configuration
 */
export async function getGuildSettings(guildId) {
  try {
    const guildDoc = await collections.getGuildSettings(guildId).get();
    
    if (!guildDoc.exists) {
      console.warn(`⚠️ Guild ${guildId} not found in database, creating default settings`);
      return await createDefaultGuildSettings(guildId);
    }
    
    const guildData = guildDoc.data();
    console.log(`🏰 Retrieved settings for guild: ${guildId}`);
    console.log(`   📋 Guild data:`, JSON.stringify(guildData, null, 2));
    
    return guildData;
    
  } catch (error) {
    console.error(`❌ Error getting guild settings for ${guildId}:`, error.message);
    throw error;
  }
}

/**
 * Create default guild settings
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} - Created guild configuration
 */
export async function createDefaultGuildSettings(guildId) {
  try {
    const defaultSettings = {
      name: guildId,
      memberCount: 0,
      discordChannels: {
        balanceUpdates: process.env.DISCORD_CHANNEL_ID || '',
        events: process.env.DISCORD_CHANNEL_ID || '',
        logs: ''
      },
      settings: {
        autoBalanceUpdates: false,
        autoEventPosts: true,
        balanceUpdateTime: '18:00',
        timezone: 'UTC'
      },
      createdAt: new Date(),
      lastUpdated: new Date()
    };
    
    await collections.getGuildSettings(guildId).set(defaultSettings);
    
    console.log(`🆕 Created default settings for guild: ${guildId}`);
    return defaultSettings;
    
  } catch (error) {
    console.error(`❌ Error creating default guild settings for ${guildId}:`, error.message);
    throw error;
  }
}

/**
 * Update guild settings
 * @param {string} guildId - Guild ID
 * @param {Object} updates - Settings to update
 * @returns {Promise<void>}
 */
export async function updateGuildSettings(guildId, updates) {
  try {
    const updateData = {
      ...updates,
      lastUpdated: new Date()
    };
    
    await collections.getGuildSettings(guildId).update(updateData);
    
    console.log(`✅ Updated settings for guild ${guildId}:`, Object.keys(updates));
    
  } catch (error) {
    console.error(`❌ Error updating guild settings for ${guildId}:`, error.message);
    throw error;
  }
}

/**
 * Get Discord channel ID for a specific purpose
 * @param {string} guildId - Guild ID
 * @param {string} channelType - Channel type (events, balanceUpdates, logs)
 * @param {string} specificChannelId - Optional specific channel ID (for multiple channels mode)
 * @returns {Promise<string>} - Discord channel ID
 */
export async function getDiscordChannelId(guildId, channelType = 'events', specificChannelId = null) {
  try {
    const guildSettings = await getGuildSettings(guildId);
    
    console.log(`📺 Looking for ${channelType} channel in guild: ${guildId}`);
    
    if (!guildSettings.discordChannels) {
      console.warn(`⚠️ No discordChannels field found for guild ${guildId}`);
      console.warn(`   Available fields:`, Object.keys(guildSettings));
      return process.env.DISCORD_CHANNEL_ID || '';
    }
    
    const channelData = guildSettings.discordChannels[channelType];
    
    // Check if multiple channels are configured (array format)
    if (Array.isArray(channelData)) {
      console.log(`   📋 Multiple channels configured for ${channelType}`);
      
      // If a specific channel ID is provided, use it
      if (specificChannelId) {
        console.log(`   ✅ Using specific channel ID: ${specificChannelId}`);
        return specificChannelId;
      }
      
      // Otherwise, use the first channel as default
      if (channelData.length > 0 && channelData[0].id) {
        console.log(`   🔄 Using first channel as default: ${channelData[0].name} (${channelData[0].id})`);
        return channelData[0].id;
      }
      
      console.warn(`⚠️ Multiple channels configured but none available`);
      return process.env.DISCORD_CHANNEL_ID || '';
    }
    
    // Single channel mode (string format)
    if (!channelData || channelData === '') {
      console.warn(`⚠️ No ${channelType} channel configured for guild ${guildId}`);
      console.warn(`   Available channels:`, guildSettings.discordChannels);
      
      // Try to use events channel as fallback
      const fallbackChannel = guildSettings.discordChannels.events || process.env.DISCORD_CHANNEL_ID || '';
      console.log(`   🔄 Using fallback channel: ${fallbackChannel}`);
      return fallbackChannel;
    }
    
    console.log(`   ✅ Found ${channelType} channel for guild ${guildId}: ${channelData}`);
    return channelData;
    
  } catch (error) {
    console.error(`❌ Error getting Discord channel for guild ${guildId}:`, error.message);
    // Fallback to environment variable
    return process.env.DISCORD_CHANNEL_ID || '';
  }
}

/**
 * Check if auto posting is enabled for a guild
 * @param {string} guildId - Guild ID
 * @param {string} postType - Type of post (events, balanceUpdates)
 * @returns {Promise<boolean>} - Whether auto posting is enabled
 */
export async function isAutoPostingEnabled(guildId, postType = 'events') {
  try {
    const guildSettings = await getGuildSettings(guildId);
    
    if (!guildSettings.settings) {
      return postType === 'events'; // Default: events enabled, balance disabled
    }
    
    const settingKey = postType === 'events' ? 'autoEventPosts' : 'autoBalanceUpdates';
    return guildSettings.settings[settingKey] || false;
    
  } catch (error) {
    console.error(`❌ Error checking auto posting for guild ${guildId}:`, error.message);
    return false;
  }
}

/**
 * Get guild timezone for scheduling
 * @param {string} guildId - Guild ID
 * @returns {Promise<string>} - Guild timezone
 */
export async function getGuildTimezone(guildId) {
  try {
    const guildSettings = await getGuildSettings(guildId);
    return guildSettings.settings?.timezone || 'UTC';
  } catch (error) {
    console.error(`❌ Error getting guild timezone for ${guildId}:`, error.message);
    return 'UTC';
  }
}

/**
 * Validate guild settings structure
 * @param {Object} settings - Settings object to validate
 * @returns {boolean} - Whether settings are valid
 */
export function validateGuildSettings(settings) {
  const requiredFields = ['name', 'discordChannels', 'settings'];
  
  for (const field of requiredFields) {
    if (!settings[field]) {
      console.warn(`⚠️ Missing required field in guild settings: ${field}`);
      return false;
    }
  }
  
  // Validate Discord channels
  if (!settings.discordChannels.events) {
    console.warn(`⚠️ Events channel is required for guild settings`);
    return false;
  }
  
  return true;
}

/**
 * List all guilds and their configured channels
 * @returns {Promise<Array>} - Array of guild configurations
 */
export async function listAllGuildsWithChannels() {
  try {
    const { getDb } = await import('./firebase.js');
    const guildsSnapshot = await getDb().collection('guilds').get();
    
    const guildsInfo = [];
    
    for (const doc of guildsSnapshot.docs) {
      const guildId = doc.id;
      const guildData = doc.data();
      
      guildsInfo.push({
        guildId,
        name: guildData.name || guildId,
        discordChannels: guildData.discordChannels || {},
        hasEventChannel: !!(guildData.discordChannels?.events),
        autoEventPosts: guildData.settings?.autoEventPosts !== false
      });
    }
    
    console.log(`\n📊 Guild Configuration Summary:`);
    console.log(`   Total guilds: ${guildsInfo.length}\n`);
    
    guildsInfo.forEach(guild => {
      console.log(`🏰 ${guild.name} (${guild.guildId})`);
      console.log(`   Events Channel: ${guild.discordChannels.events || '❌ NOT SET'}`);
      console.log(`   Balance Channel: ${guild.discordChannels.balanceUpdates || '❌ NOT SET'}`);
      console.log(`   Logs Channel: ${guild.discordChannels.logs || '❌ NOT SET'}`);
      console.log(`   Auto-post enabled: ${guild.autoEventPosts ? '✅' : '❌'}`);
      console.log('');
    });
    
    return guildsInfo;
    
  } catch (error) {
    console.error('❌ Error listing guilds:', error.message);
    return [];
  }
}

export default {
  getGuildSettings,
  createDefaultGuildSettings,
  updateGuildSettings,
  getDiscordChannelId,
  isAutoPostingEnabled,
  getGuildTimezone,
  validateGuildSettings,
  listAllGuildsWithChannels
};