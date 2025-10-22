import { collections } from './firebase.js';
import { postToDiscord, updateDiscordMessage } from './discordService.js';

let unsubscribeListeners = [];

/**
 * Initialize all Firestore listeners
 */
export function initializeFirestoreListeners() {
  console.log('🔥 Setting up Firestore listeners...');
  
  // Listen for new Discord posts
  setupNewPostListener();
  
  // Listen for post updates
  setupPostUpdateListener();
  
  console.log('✅ Firestore listeners initialized');
}

/**
 * Listen for new documents in discord_posts collection
 */
function setupNewPostListener() {
  const unsubscribe = collections.get(collections.DISCORD_POSTS)
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
      
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const docId = change.doc.id;
          const postData = change.doc.data();
          
          console.log(`📬 New post detected: ${docId}`);
          
          try {
            // Post to Discord
            const discordMessageData = await postToDiscord(postData);
            
            // Update Firestore with Discord message metadata
            await collections.get(collections.DISCORD_POSTS).doc(docId).update({
              status: 'posted',
              discordMessageId: discordMessageData.messageId,
              discordChannelId: discordMessageData.channelId,
              discordUrl: discordMessageData.url,
              postedAt: new Date(),
              reactions: { '✅': 0 } // Initialize reaction count
            });
            
            console.log(`✅ Posted to Discord and updated Firestore: ${docId}`);
            
          } catch (error) {
            console.error(`❌ Error processing new post ${docId}:`, error.message);
            
            // Update status to error
            await collections.get(collections.DISCORD_POSTS).doc(docId).update({
              status: 'error',
              error: error.message,
              errorAt: new Date()
            });
          }
        }
      });
    });
  
  unsubscribeListeners.push(unsubscribe);
}

/**
 * Listen for post update requests
 */
function setupPostUpdateListener() {
  const unsubscribe = collections.get(collections.DISCORD_POSTS)
    .where('updateRequested', '==', true)
    .onSnapshot(async (snapshot) => {
      
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'modified') {
          const docId = change.doc.id;
          const postData = change.doc.data();
          
          console.log(`🔄 Post update requested: ${docId}`);
          
          try {
            if (!postData.discordMessageId) {
              throw new Error('No Discord message ID found for post');
            }
            
            // Update Discord message
            await updateDiscordMessage(postData.discordMessageId, postData);
            
            // Mark update as completed
            await collections.get(collections.DISCORD_POSTS).doc(docId).update({
              updateRequested: false,
              lastUpdated: new Date()
            });
            
            console.log(`✅ Updated Discord message: ${postData.discordMessageId}`);
            
          } catch (error) {
            console.error(`❌ Error updating post ${docId}:`, error.message);
            
            // Reset update request flag and log error
            await collections.get(collections.DISCORD_POSTS).doc(docId).update({
              updateRequested: false,
              updateError: error.message,
              updateErrorAt: new Date()
            });
          }
        }
      });
    });
  
  unsubscribeListeners.push(unsubscribe);
}

/**
 * Create a new Discord post in Firestore
 * @param {Object} postData - Post data
 * @returns {Promise<string>} - Document ID
 */
export async function createDiscordPost(postData) {
  try {
    const postDoc = {
      ...postData,
      status: 'pending',
      createdAt: new Date(),
      reactions: { '✅': 0 }
    };
    
    const docRef = await collections.get(collections.DISCORD_POSTS).add(postDoc);
    console.log(`📝 Created new Discord post document: ${docRef.id}`);
    
    return docRef.id;
    
  } catch (error) {
    console.error('❌ Error creating Discord post:', error.message);
    throw error;
  }
}

/**
 * Request an update to an existing Discord post
 * @param {string} postId - Firestore document ID
 * @param {Object} updateData - Data to update
 */
export async function requestPostUpdate(postId, updateData) {
  try {
    await collections.get(collections.DISCORD_POSTS).doc(postId).update({
      ...updateData,
      updateRequested: true,
      updateRequestedAt: new Date()
    });
    
    console.log(`🔄 Requested update for post: ${postId}`);
    
  } catch (error) {
    console.error('❌ Error requesting post update:', error.message);
    throw error;
  }
}

/**
 * Update reaction count for a post
 * @param {string} discordMessageId - Discord message ID
 * @param {string} emoji - Reaction emoji
 * @param {number} count - New reaction count
 */
export async function updateReactionCount(discordMessageId, emoji, count) {
  try {
    const querySnapshot = await collections.get(collections.DISCORD_POSTS)
      .where('discordMessageId', '==', discordMessageId)
      .get();
    
    if (querySnapshot.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }
    
    const postDoc = querySnapshot.docs[0];
    const currentReactions = postDoc.data().reactions || {};
    
    await postDoc.ref.update({
      [`reactions.${emoji}`]: count,
      lastReactionUpdate: new Date()
    });
    
    console.log(`✅ Updated reaction count for ${emoji}: ${count}`);
    
  } catch (error) {
    console.error('❌ Error updating reaction count:', error.message);
    throw error;
  }
}

/**
 * Stop all Firestore listeners
 */
export function stopFirestoreListeners() {
  unsubscribeListeners.forEach(unsubscribe => {
    unsubscribe();
  });
  unsubscribeListeners = [];
  console.log('🛑 Stopped all Firestore listeners');
}

export default {
  initializeFirestoreListeners,
  createDiscordPost,
  requestPostUpdate,
  updateReactionCount,
  stopFirestoreListeners
};