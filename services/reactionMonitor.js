import { Events } from 'discord.js';
import { updateReactionCount, handleRoamSignup, handleRoamUnsignup } from './firestoreListeners.js';
import { getDiscordClient } from './discordService.js';
import { getGuildId } from './guildContext.js';
import { collections } from './firebase.js';

/**
 * Determine guild ID from a Discord message ID
 * @param {string} messageId - Discord message ID
 * @returns {Promise<string|null>} - Guild ID or null if not found
 */
async function getGuildIdFromMessage(messageId) {
  try {
    // Search across all guilds to find which one contains this message
    // For now, we'll try the default guild first
    const defaultGuild = getGuildId();
    
    const query = await collections.getDiscordPosts(defaultGuild)
      .where('discordMessageId', '==', messageId)
      .limit(1)
      .get();
    
    if (!query.empty) {
      return defaultGuild;
    }
    
    // TODO: In the future, we could search across multiple guilds
    // For now, return null if not found in default guild
    console.warn(`⚠️ Message ${messageId} not found in any guild database`);
    return null;
    
  } catch (error) {
    console.error(`❌ Error determining guild for message ${messageId}:`, error.message);
    return null;
  }
}

/**
 * Initialize Discord reaction monitoring for all guilds
 */
export function initializeReactionMonitoring() {
  const client = getDiscordClient();

  if (!client) {
    console.error('❌ Discord client not available for reaction monitoring');
    return;
  }

  console.log('👀 Setting up Discord reaction monitoring for all guilds...');
  console.log('   📋 Monitoring all Discord channels for ✅ reactions');
  console.log('   🔍 Will match message IDs against all guild databases');

  // Monitor when reactions are added
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Make sure we have the full reaction object
      if (reaction.partial) {
        await reaction.fetch();
      }

      // Determine which guild this message belongs to
      const guildId = await getGuildIdFromMessage(reaction.message.id);
      if (!guildId) {
        console.log(`⚠️ Could not determine guild for message ${reaction.message.id}`);
        return;
      }

      // Only monitor ✅ reactions for roam signups
      if (reaction.emoji.name === '✅') {
        const messageId = reaction.message.id;
        const reactionCount = reaction.count;
        const discordUserId = user.id;
        const discordUsername = user.username;

        console.log(`➕ User ${discordUsername} (${discordUserId}) added ✅ reaction to message ${messageId} (total: ${reactionCount})`);

        // Update reaction count in Firestore
        await updateReactionCount(messageId, '✅', reactionCount, guildId);

        // Handle roam signup (pass Discord ID and username)
        await handleRoamSignup(messageId, discordUserId, discordUsername, guildId);
      }

    } catch (error) {
      console.error('❌ Error handling reaction add:', error.message);
    }
  });

  // Monitor when reactions are removed
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Make sure we have the full reaction object
      if (reaction.partial) {
        await reaction.fetch();
      }

      // Determine which guild this message belongs to
      const guildId = await getGuildIdFromMessage(reaction.message.id);
      if (!guildId) {
        console.log(`⚠️ Could not determine guild for message ${reaction.message.id}`);
        return;
      }

      // Only monitor ✅ reactions for roam signups
      if (reaction.emoji.name === '✅') {
        const messageId = reaction.message.id;
        const reactionCount = reaction.count;
        const discordUserId = user.id;
        const discordUsername = user.username;

        console.log(`➖ User ${discordUsername} (${discordUserId}) removed ✅ reaction from message ${messageId} (total: ${reactionCount})`);

        // Update reaction count in Firestore
        await updateReactionCount(messageId, '✅', reactionCount, guildId);

        // Handle roam unsignup (pass Discord ID and username)
        await handleRoamUnsignup(messageId, discordUserId, discordUsername, guildId);
      }

    } catch (error) {
      console.error('❌ Error handling reaction remove:', error.message);
    }
  });

  // Monitor when all reactions of a type are removed
  client.on(Events.MessageReactionRemoveAll, async (message) => {
    try {
      // Only monitor reactions in our target channel
      if (message.channel.id !== targetChannelId) {
        return;
      }

      console.log(`🧹 All reactions removed from message ${message.id}`);

      // Reset all reaction counts to 0
      await updateReactionCount(message.id, '✅', 0);

    } catch (error) {
      console.error('❌ Error handling reaction remove all:', error.message);
    }
  });

  console.log('✅ Discord reaction monitoring initialized');
}

/**
 * Get reaction statistics for a message
 * @param {string} messageId - Discord message ID
 * @returns {Promise<Object>} - Reaction statistics
 */
export async function getMessageReactionStats(messageId) {
  try {
    const client = getDiscordClient();
    const targetChannelId = getTargetChannelId();

    if (!client || !client.isReady()) {
      throw new Error('Discord client not ready');
    }

    const channel = await client.channels.fetch(targetChannelId);
    const message = await channel.messages.fetch(messageId);

    const reactionStats = {};
    
    message.reactions.cache.forEach((reaction) => {
      reactionStats[reaction.emoji.name] = reaction.count;
    });

    return reactionStats;

  } catch (error) {
    console.error('❌ Error getting reaction stats:', error.message);
    throw error;
  }
}

/**
 * Sync all reaction counts for messages in Firestore
 * Useful for initial setup or fixing discrepancies
 */
export async function syncAllReactionCounts() {
  try {
    console.log('🔄 Starting reaction count sync...');
    
    const { collections } = await import('./firebase.js');
    
    // Get all posted Discord messages from Firestore
    const snapshot = await collections.get(collections.DISCORD_POSTS)
      .where('status', '==', 'posted')
      .where('discordMessageId', '!=', null)
      .get();

    let syncCount = 0;

    for (const doc of snapshot.docs) {
      const postData = doc.data();
      const messageId = postData.discordMessageId;

      try {
        // Get current reaction stats from Discord
        const reactionStats = await getMessageReactionStats(messageId);
        
        // Update Firestore with current counts
        await doc.ref.update({
          reactions: reactionStats,
          lastReactionSync: new Date()
        });

        syncCount++;
        console.log(`✅ Synced reactions for message ${messageId}:`, reactionStats);

      } catch (error) {
        console.warn(`⚠️ Could not sync reactions for message ${messageId}:`, error.message);
      }
    }

    console.log(`🎯 Reaction sync complete. Synced ${syncCount} messages.`);
    return syncCount;

  } catch (error) {
    console.error('❌ Error syncing reaction counts:', error.message);
    throw error;
  }
}

export default {
  initializeReactionMonitoring,
  getMessageReactionStats,
  syncAllReactionCounts
};