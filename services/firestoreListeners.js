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
 * Listen for post update requests and automatic content updates
 */
function setupPostUpdateListener() {
  // Listen for manual update requests
  const manualUpdateUnsubscribe = collections.get(collections.DISCORD_POSTS)
    .where('updateRequested', '==', true)
    .onSnapshot(async (snapshot) => {
      
      console.log(`👂 Update listener triggered - ${snapshot.docChanges().length} changes detected`);
      
      snapshot.docChanges().forEach(async (change) => {
        console.log(`📝 Change type: ${change.type}, Doc ID: ${change.doc.id}`);
        console.log(`📋 Document data:`, change.doc.data());
        
        if (change.type === 'modified' || change.type === 'added') {
          const docId = change.doc.id;
          const postData = change.doc.data();
          
          console.log(`🔄 Manual post update requested: ${docId}`);
          console.log(`🔍 updateRequested value:`, postData.updateRequested);
          
          await handleDiscordMessageUpdate(docId, postData, 'manual update');
        }
      });
    });

  // Listen for automatic content updates (when key fields change)
  const autoUpdateUnsubscribe = collections.get(collections.DISCORD_POSTS)
    .where('status', '==', 'posted')
    .onSnapshot(async (snapshot) => {
      
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'modified') {
          const docId = change.doc.id;
          const postData = change.doc.data();
          
          // Skip if this is a manual update request or internal update
          if (postData.updateRequested || postData._isInternalUpdate) {
            return;
          }
          
          // Check if important content fields were updated
          const previousData = change.doc.data();
          const fieldsToWatch = ['title', 'description', 'additionalInfo', 'roamDetails'];
          
          const hasContentChanges = fieldsToWatch.some(field => {
            // For new snapshot listener, we can't easily get previous data
            // So we'll rely on the manual updateRequested flag for now
            return false; // Disable auto-updates for now
          });
          
          if (hasContentChanges) {
            console.log(`🔄 Auto-detected content changes in post: ${docId}`);
            await handleDiscordMessageUpdate(docId, postData, 'auto-detected changes');
          }
        }
      });
    });
  
  unsubscribeListeners.push(manualUpdateUnsubscribe);
  unsubscribeListeners.push(autoUpdateUnsubscribe);
}

/**
 * Handle Discord message updates (both manual and automatic)
 * @param {string} docId - Firestore document ID
 * @param {Object} postData - Post data
 * @param {string} updateType - Type of update for logging
 */
async function handleDiscordMessageUpdate(docId, postData, updateType) {
  try {
    if (!postData.discordMessageId) {
      throw new Error('No Discord message ID found for post');
    }
    
    // Update Discord message with latest content
    await updateDiscordMessage(postData.discordMessageId, postData);
    
    // Mark update as completed
    const updateData = {
      lastUpdated: new Date(),
      _isInternalUpdate: true // Prevent infinite loops
    };
    
    // Clear manual update flag if it was set
    if (postData.updateRequested) {
      updateData.updateRequested = false;
    }
    
    await collections.get(collections.DISCORD_POSTS).doc(docId).update(updateData);
    
    // Remove the internal flag after a brief delay
    setTimeout(async () => {
      await collections.get(collections.DISCORD_POSTS).doc(docId).update({
        _isInternalUpdate: false
      });
    }, 1000);
    
    console.log(`✅ Updated Discord message (${updateType}): ${postData.discordMessageId}`);
    
  } catch (error) {
    console.error(`❌ Error updating post ${docId} (${updateType}):`, error.message);
    
    // Reset flags and log error
    const errorUpdate = {
      updateError: error.message,
      updateErrorAt: new Date(),
      _isInternalUpdate: true
    };
    
    if (postData.updateRequested) {
      errorUpdate.updateRequested = false;
    }
    
    await collections.get(collections.DISCORD_POSTS).doc(docId).update(errorUpdate);
  }
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
 * Handle user signup for a roam when they react with ✅
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 */
export async function handleRoamSignup(discordMessageId, discordUserId, discordUsername = 'Unknown') {
  try {
    // Get user document directly using Discord ID as document ID
    const userDoc = await collections.get('users').doc(discordUserId).get();
    
    let isRegisteredUser = false;
    let userData = null;
    
    if (userDoc.exists) {
      isRegisteredUser = true;
      userData = userDoc.data();
      console.log(`✅ Found registered user: ${userData.username || userData.displayName} (Discord ID: ${discordUserId})`);
    } else {
      console.log(`👤 Guest user reaction from Discord user: ${discordUsername} (${discordUserId})`);
    }
    
    
    // Get the discord post to find the roamId
    const postQuery = await collections.get(collections.DISCORD_POSTS)
      .where('discordMessageId', '==', discordMessageId)
      .get();
    
    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }
    
    const postData = postQuery.docs[0].data();
    const roamId = postData.roamId;
    
    if (!roamId) {
      console.warn(`⚠️ No roamId found in post for message: ${discordMessageId}`);
      return;
    }
    
    // Get the roam document from gameData/roams collection
    const roamRef = collections.get('gameData').doc('roams');
    const roamDoc = await roamRef.get();
    
    if (!roamDoc.exists) {
      console.error(`❌ gameData/roams document not found`);
      return;
    }
    
    const roamData = roamDoc.data();
    const scheduledRoams = roamData.scheduled || [];
    
    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex(roam => roam.id === roamId);
    
    if (roamIndex === -1) {
      console.warn(`⚠️ Roam with ID ${roamId} not found in scheduled roams`);
      return;
    }
    
    const roam = scheduledRoams[roamIndex];
    const signups = roam.signups || [];
    const guests = roam.guests || [];
    
    if (isRegisteredUser) {
      // Handle registered user signup
      if (signups.includes(discordUserId)) {
        console.log(`ℹ️ User ${userData.username || userData.displayName} (${discordUserId}) already signed up for roam ${roamId}`);
        return;
      }
      
      // Remove from guests if they were there (user got registered)
      const updatedGuests = guests.filter(guest => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === 'string' ? guest : guest.discordId;
        return guestId !== discordUserId;
      });
      
      if (updatedGuests.length !== guests.length) {
        console.log(`🔄 Moving user ${discordUserId} from guests to registered signups`);
        roam.guests = updatedGuests;
      }
      
      // Add to registered signups
      signups.push(discordUserId);
      roam.signups = signups;
      
      console.log(`✅ Registered user ${userData.username || userData.displayName} (${discordUserId}) signed up for roam ${roamId} (${signups.length} registered, ${updatedGuests.length} guests)`);
      
    } else {
      // Handle guest signup
      const existingGuestIndex = guests.findIndex(guest => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === 'string' ? guest : guest.discordId;
        return guestId === discordUserId;
      });
      
      if (existingGuestIndex !== -1) {
        console.log(`ℹ️ Guest user ${discordUsername} (${discordUserId}) already in guests list for roam ${roamId}`);
        return;
      }
      
      // Check if they're already in registered signups (shouldn't happen, but safety check)
      if (signups.includes(discordUserId)) {
        console.log(`ℹ️ User ${discordUserId} already in registered signups for roam ${roamId}`);
        return;
      }
      
      // Add to guests with both ID and username
      const guestInfo = {
        discordId: discordUserId,
        discordUsername: discordUsername,
        addedAt: new Date()
      };
      
      guests.push(guestInfo);
      roam.guests = guests;
      
      console.log(`👤 Guest user ${discordUsername} (${discordUserId}) added to roam ${roamId} (${signups.length} registered, ${guests.length} guests)`);
    }
    
    scheduledRoams[roamIndex] = roam;
    
    // Update the document
    await roamRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date()
    });
    
  } catch (error) {
    console.error('❌ Error handling roam signup:', error.message);
    throw error;
  }
}

/**
 * Handle user unsignup for a roam when they remove ✅ reaction
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 */
export async function handleRoamUnsignup(discordMessageId, discordUserId, discordUsername = 'Unknown') {
  try {
    // Get user document directly using Discord ID as document ID
    const userDoc = await collections.get('users').doc(discordUserId).get();
    
    let isRegisteredUser = false;
    let userData = null;
    
    if (userDoc.exists) {
      isRegisteredUser = true;
      userData = userDoc.data();
      console.log(`✅ Found registered user for unsignup: ${userData.username || userData.displayName} (Discord ID: ${discordUserId})`);
    } else {
      console.log(`👤 Guest user unsignup from Discord ID: ${discordUserId}`);
    }

    // Get the discord post to find the roamId
    const postQuery = await collections.get(collections.DISCORD_POSTS)
      .where('discordMessageId', '==', discordMessageId)
      .get();
    
    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }
    
    const postData = postQuery.docs[0].data();
    const roamId = postData.roamId;
    
    if (!roamId) {
      console.warn(`⚠️ No roamId found in post for message: ${discordMessageId}`);
      return;
    }
    
    // Get the roam document from gameData/roams collection
    const roamRef = collections.get('gameData').doc('roams');
    const roamDoc = await roamRef.get();
    
    if (!roamDoc.exists) {
      console.error(`❌ gameData/roams document not found`);
      return;
    }
    
    const roamData = roamDoc.data();
    const scheduledRoams = roamData.scheduled || [];
    
    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex(roam => roam.id === roamId);
    
    if (roamIndex === -1) {
      console.warn(`⚠️ Roam with ID ${roamId} not found in scheduled roams`);
      return;
    }
    
    const roam = scheduledRoams[roamIndex];
    const signups = roam.signups || [];
    const guests = roam.guests || [];
    
    let wasRemoved = false;
    let removedFrom = '';
    
    if (isRegisteredUser) {
      // Try to remove from registered signups first
      const updatedSignups = signups.filter(userId => userId !== discordUserId);
      if (updatedSignups.length !== signups.length) {
        roam.signups = updatedSignups;
        wasRemoved = true;
        removedFrom = 'registered signups';
        console.log(`➖ Registered user ${userData.username || userData.displayName} (${discordUserId}) removed from roam ${roamId} (${updatedSignups.length} registered, ${guests.length} guests)`);
      }
    }
    
    // If not removed from registered signups (or if guest user), try removing from guests
    if (!wasRemoved) {
      const updatedGuests = guests.filter(guest => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === 'string' ? guest : guest.discordId;
        return guestId !== discordUserId;
      });
      
      if (updatedGuests.length !== guests.length) {
        roam.guests = updatedGuests;
        wasRemoved = true;
        removedFrom = 'guests';
        console.log(`➖ ${isRegisteredUser ? 'User' : 'Guest'} ${discordUserId} removed from guests for roam ${roamId} (${signups.length} registered, ${updatedGuests.length} guests)`);
      }
    }
    
    // Check if user was actually signed up anywhere
    if (!wasRemoved) {
      console.log(`ℹ️ User ${discordUserId} was not signed up for roam ${roamId}`);
      return;
    }
    
    scheduledRoams[roamIndex] = roam;
    
    // Update the document
    await roamRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date()
    });
    
  } catch (error) {
    console.error('❌ Error handling roam unsignup:', error.message);
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