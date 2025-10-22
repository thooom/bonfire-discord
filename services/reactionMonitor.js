import { Events } from 'discord.js';
import { updateReactionCount, handleRoamSignup, handleRoamUnsignup } from './firestoreListeners.js';
import { getDiscordClient, getTargetChannelId } from './discordService.js';

/**
 * Initialize Discord reaction monitoring
 */
export function initializeReactionMonitoring() {
  const client = getDiscordClient();
  const targetChannelId = getTargetChannelId();

  if (!client) {
    console.error('❌ Discord client not available for reaction monitoring');
    return;
  }

  console.log('👀 Setting up Discord reaction monitoring...');

  // Monitor when reactions are added
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      // Ignore bot reactions
      if (user.bot) return;

      // Make sure we have the full reaction object
      if (reaction.partial) {
        await reaction.fetch();
      }

      // Only monitor reactions in our target channel
      if (reaction.message.channel.id !== targetChannelId) {
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
        await updateReactionCount(messageId, '✅', reactionCount);

        // Handle roam signup (only pass Discord ID)
        await handleRoamSignup(messageId, discordUserId);
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

      // Only monitor reactions in our target channel
      if (reaction.message.channel.id !== targetChannelId) {
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
        await updateReactionCount(messageId, '✅', reactionCount);

        // Handle roam unsignup (only pass Discord ID)
        await handleRoamUnsignup(messageId, discordUserId);
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