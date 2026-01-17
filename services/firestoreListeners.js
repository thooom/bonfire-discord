import { collections, getDb } from "./firebase.js";
import {
  postToDiscord,
  updateDiscordMessage,
  getDiscordClient,
} from "./discordService.js";
import { postRoamSummary, updateRoamSummary } from "./roamSummaryService.js";
import { getGuildId } from "./guildContext.js";

let unsubscribeListeners = [];
let guildConfigListeners = new Map(); // Track guild config listeners

/**
 * Get all guilds from the database
 * @returns {Promise<string[]>} - Array of guild IDs
 */
async function getAllGuilds() {
  try {
    const guildsSnapshot = await getDb().collection("guilds").listDocuments();
    const guildIds = guildsSnapshot.map((doc) => doc.id);
    console.log(
      `🏰 Found ${guildIds.length} guilds in database: ${guildIds.join(", ")}`,
    );
    return guildIds;
  } catch (error) {
    console.error("❌ Error getting guilds:", error.message);
    // Fallback to default guild if we can't get the list
    return [getGuildId()];
  }
}

/**
 * Setup listener for guild configuration changes
 * @param {string} guildId - Guild ID
 */
function setupGuildConfigListener(guildId) {
  console.log(`⚙️ Setting up configuration listener for guild: ${guildId}`);

  const unsubscribe = getDb()
    .collection("guilds")
    .doc(guildId)
    .onSnapshot(
      async (docSnapshot) => {
        if (!docSnapshot.exists) {
          console.warn(`⚠️ Guild ${guildId} document no longer exists`);
          return;
        }

        const guildData = docSnapshot.data();
        const discordChannels = guildData.discordChannels || {};

        console.log(`🔄 Guild configuration changed for: ${guildId}`);
        console.log(
          `   📺 Events Channel: ${discordChannels.events || "NOT SET"}`,
        );
        console.log(
          `   📊 Balance Channel: ${discordChannels.balanceUpdates || "NOT SET"}`,
        );
        console.log(`   📝 Logs Channel: ${discordChannels.logs || "NOT SET"}`);
        console.log(
          `   🎯 Auto-post: ${guildData.settings?.autoEventPosts !== false ? "Enabled" : "Disabled"}`,
        );

        // If channels changed, the existing listeners will use the new values
        // automatically on next post (no need to restart listeners)
      },
      (error) => {
        console.error(
          `❌ Error in guild config listener for ${guildId}:`,
          error.message,
        );
      },
    );

  // Store the unsubscribe function
  guildConfigListeners.set(guildId, unsubscribe);
  unsubscribeListeners.push(unsubscribe);
}

/**
 * Initialize all Firestore listeners for all guilds or a specific guild
 * @param {string} guildId - Guild ID to initialize listeners for (optional)
 */
export async function initializeFirestoreListeners(guildId = null) {
  if (guildId) {
    // Initialize for specific guild
    console.log(`🔥 Setting up Firestore listeners for guild: ${guildId}...`);
    setupGuildConfigListener(guildId);
    setupNewPostListener(guildId);
    setupPostUpdateListener(guildId);
    setupPostDeleteListener(guildId);
    console.log(`✅ Firestore listeners initialized for guild: ${guildId}`);
  } else {
    // Initialize for all guilds
    console.log(`🔥 Setting up Firestore listeners for ALL guilds...`);
    const guilds = await getAllGuilds();

    if (guilds.length === 0) {
      console.warn("⚠️ No guilds found in database, using default guild");
      const defaultGuild = getGuildId();
      setupGuildConfigListener(defaultGuild);
      setupNewPostListener(defaultGuild);
      setupPostUpdateListener(defaultGuild);
      setupPostDeleteListener(defaultGuild);
      console.log(
        `✅ Firestore listeners initialized for default guild: ${defaultGuild}`,
      );
    } else {
      for (const guild of guilds) {
        console.log(`🔥 Setting up listeners for guild: ${guild}`);
        setupGuildConfigListener(guild);
        setupNewPostListener(guild);
        setupPostUpdateListener(guild);
        setupPostDeleteListener(guild);
      }
      console.log(
        `✅ Firestore listeners initialized for ${guilds.length} guild(s): ${guilds.join(", ")}`,
      );
    }

    // Also listen for new guilds being added
    setupNewGuildListener();
  }
}

/**
 * Listen for new documents in discord_posts collection for a specific guild
 * @param {string} guildId - Guild ID
 */
function setupNewPostListener(guildId) {
  console.log(`👂 Starting to listen for NEW posts in guild: ${guildId}`);
  console.log(`   📍 Collection path: guilds/${guildId}/discord_posts`);
  console.log(`   🔍 Filtering: status == 'pending'`);

  const unsubscribe = collections
    .getDiscordPosts(guildId)
    .where("status", "==", "pending")
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const docId = change.doc.id;
          const postData = change.doc.data();

          console.log(`📬 New post detected for guild ${guildId}: ${docId}`);
          console.log(`   📋 Post type: ${postData.postType || "standard"}`);

          try {
            // Route to appropriate handler based on post type
            let discordMessageData;

            if (postData.postType === "roamSummary") {
              // Post roam summary to logs channel
              discordMessageData = await postRoamSummary(
                postData,
                guildId,
                getDiscordClient(),
              );
            } else {
              // Post regular events to events channel
              discordMessageData = await postToDiscord(postData, guildId);
            }

            // Update Firestore with Discord message metadata
            await collections
              .getDiscordPosts(guildId)
              .doc(docId)
              .update({
                status: "posted",
                discordMessageId: discordMessageData.messageId,
                discordChannelId: discordMessageData.channelId,
                discordUrl: discordMessageData.url,
                postedAt: new Date(),
                reactions: { "✅": 0 }, // Initialize reaction count
              });

            console.log(
              `✅ Posted to Discord and updated Firestore for guild ${guildId}: ${docId}`,
            );
          } catch (error) {
            console.error(
              `❌ Error processing new post ${docId} for guild ${guildId}:`,
              error.message,
            );

            // Update status to error
            await collections.getDiscordPosts(guildId).doc(docId).update({
              status: "error",
              error: error.message,
              errorAt: new Date(),
            });
          }
        }
      });
    });

  unsubscribeListeners.push(unsubscribe);
}

/**
 * Listen for post update requests and automatic content updates for a specific guild
 * @param {string} guildId - Guild ID
 */
function setupPostUpdateListener(guildId) {
  console.log(`👂 Starting to listen for POST UPDATES in guild: ${guildId}`);
  console.log(`   📍 Collection path: guilds/${guildId}/discord_posts`);
  console.log(`   🔍 Filtering: updateRequested == true OR status == 'posted'`);

  // Listen for manual update requests
  const manualUpdateUnsubscribe = collections
    .getDiscordPosts(guildId)
    .where("updateRequested", "==", true)
    .onSnapshot(async (snapshot) => {
      console.log(
        `👂 Update listener triggered for guild ${guildId} - ${snapshot.docChanges().length} changes detected`,
      );

      snapshot.docChanges().forEach(async (change) => {
        console.log(`📝 Change type: ${change.type}, Doc ID: ${change.doc.id}`);
        console.log(`📋 Document data:`, change.doc.data());

        if (change.type === "modified" || change.type === "added") {
          const docId = change.doc.id;
          const postData = change.doc.data();

          console.log(
            `🔄 Manual post update requested for guild ${guildId}: ${docId}`,
          );
          console.log(`🔍 updateRequested value:`, postData.updateRequested);

          await handleDiscordMessageUpdate(
            docId,
            postData,
            "manual update",
            guildId,
          );
        }
      });
    });

  // Listen for automatic content updates (when key fields change)
  const autoUpdateUnsubscribe = collections
    .getDiscordPosts(guildId)
    .where("status", "==", "posted")
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "modified") {
          const docId = change.doc.id;
          const postData = change.doc.data();

          // Skip if this is a manual update request or internal update
          if (postData.updateRequested || postData._isInternalUpdate) {
            return;
          }

          // Check if important content fields were updated
          const previousData = change.doc.data();
          const fieldsToWatch = [
            "title",
            "description",
            "additionalInfo",
            "roamDetails",
          ];

          const hasContentChanges = fieldsToWatch.some((field) => {
            // For new snapshot listener, we can't easily get previous data
            // So we'll rely on the manual updateRequested flag for now
            return false; // Disable auto-updates for now
          });

          if (hasContentChanges) {
            console.log(
              `🔄 Auto-detected content changes in post for guild ${guildId}: ${docId}`,
            );
            await handleDiscordMessageUpdate(
              docId,
              postData,
              "auto-detected changes",
              guildId,
            );
          }
        }
      });
    });

  unsubscribeListeners.push(manualUpdateUnsubscribe);
  unsubscribeListeners.push(autoUpdateUnsubscribe);
}

/**
 * Listen for post delete requests for a specific guild
 * @param {string} guildId - Guild ID
 */
function setupPostDeleteListener(guildId) {
  console.log(`👂 Starting to listen for POST DELETES in guild: ${guildId}`);
  console.log(`   📍 Collection path: guilds/${guildId}/discord_posts`);
  console.log(`   🔍 Filtering: deleteRequested == true`);

  const unsubscribe = collections
    .getDiscordPosts(guildId)
    .where("deleteRequested", "==", true)
    .onSnapshot(async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "modified" || change.type === "added") {
          const docId = change.doc.id;
          const postData = change.doc.data();

          console.log(
            `🗑️ Post delete requested for guild ${guildId}: ${docId}`,
          );

          try {
            // Delete the Discord message if we have the message ID
            if (postData.discordMessageId && postData.discordChannelId) {
              const { deleteDiscordMessage } =
                await import("./discordService.js");
              await deleteDiscordMessage(
                postData.discordMessageId,
                postData.discordChannelId,
              );
              console.log(
                `✅ Deleted Discord message ${postData.discordMessageId} for guild ${guildId}`,
              );
            }

            // Update Firestore to mark as deleted
            await collections.getDiscordPosts(guildId).doc(docId).update({
              status: "deleted",
              deleteRequested: false,
              deletedAt: new Date(),
            });

            console.log(
              `✅ Marked post ${docId} as deleted in Firestore for guild ${guildId}`,
            );
          } catch (error) {
            console.error(
              `❌ Error deleting post ${docId} for guild ${guildId}:`,
              error.message,
            );

            // Update status to error
            await collections.getDiscordPosts(guildId).doc(docId).update({
              status: "error",
              deleteRequested: false,
              error: error.message,
              errorAt: new Date(),
            });
          }
        }
      });
    });

  unsubscribeListeners.push(unsubscribe);
}

/**
 * Listen for new guilds being added to the database
 */
function setupNewGuildListener() {
  console.log(`🆕 Setting up listener for new guilds in database...`);

  const unsubscribe = getDb()
    .collection("guilds")
    .onSnapshot(
      async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === "added") {
            const guildId = change.doc.id;

            // Check if we're already listening to this guild
            if (guildConfigListeners.has(guildId)) {
              console.log(`✓ Already monitoring guild: ${guildId}`);
              return;
            }

            console.log(`🆕 New guild detected: ${guildId}`);
            console.log(`   Setting up listeners for new guild...`);

            // Setup listeners for the new guild
            setupGuildConfigListener(guildId);
            setupNewPostListener(guildId);
            setupPostUpdateListener(guildId);
            setupPostDeleteListener(guildId);

            console.log(`✅ Started monitoring new guild: ${guildId}`);
          }

          if (change.type === "removed") {
            const guildId = change.doc.id;
            console.log(`🗑️ Guild removed from database: ${guildId}`);

            // Unsubscribe from this guild's listeners
            const configListener = guildConfigListeners.get(guildId);
            if (configListener) {
              configListener();
              guildConfigListeners.delete(guildId);
              console.log(`✅ Stopped monitoring removed guild: ${guildId}`);
            }
          }
        });
      },
      (error) => {
        console.error(`❌ Error in new guild listener:`, error.message);
      },
    );

  unsubscribeListeners.push(unsubscribe);
}

/**
 * Handle Discord message updates (both manual and automatic)
 * @param {string} docId - Firestore document ID
 * @param {Object} postData - Post data
 * @param {string} updateType - Type of update for logging
 * @param {string} guildId - Guild ID
 */
async function handleDiscordMessageUpdate(
  docId,
  postData,
  updateType,
  guildId,
) {
  try {
    if (!postData.discordMessageId) {
      throw new Error("No Discord message ID found for post");
    }

    // Route update to appropriate handler based on post type
    if (postData.postType === "roamSummary") {
      // Update roam summary in logs channel
      await updateRoamSummary(
        postData.discordMessageId,
        postData,
        guildId,
        getDiscordClient(),
      );
    } else {
      // Update regular message in events channel
      await updateDiscordMessage(postData.discordMessageId, postData, guildId);
    }

    // Mark update as completed
    const updateData = {
      lastUpdated: new Date(),
      _isInternalUpdate: true, // Prevent infinite loops
    };

    // Clear manual update flag if it was set
    if (postData.updateRequested) {
      updateData.updateRequested = false;
    }

    await collections.getDiscordPosts(guildId).doc(docId).update(updateData);

    // Remove the internal flag after a brief delay
    setTimeout(async () => {
      await collections.getDiscordPosts(guildId).doc(docId).update({
        _isInternalUpdate: false,
      });
    }, 1000);

    console.log(
      `✅ Updated Discord message for guild ${guildId} (${updateType}): ${postData.discordMessageId}`,
    );
  } catch (error) {
    console.error(
      `❌ Error updating post ${docId} for guild ${guildId} (${updateType}):`,
      error.message,
    );

    // Reset flags and log error
    const errorUpdate = {
      updateError: error.message,
      updateErrorAt: new Date(),
      _isInternalUpdate: true,
    };

    if (postData.updateRequested) {
      errorUpdate.updateRequested = false;
    }

    await collections.getDiscordPosts(guildId).doc(docId).update(errorUpdate);
  }
}

/**
 * Create a new Discord post in Firestore
 * @param {Object} postData - Post data
 * @param {string} guildId - Guild ID (optional, defaults to environment)
 * @returns {Promise<string>} - Document ID
 */
export async function createDiscordPost(postData, guildId = null) {
  try {
    const guild = guildId || getGuildId();

    const postDoc = {
      ...postData,
      guildId: guild,
      status: "pending",
      createdAt: new Date(),
      reactions: { "✅": 0 },
    };

    const docRef = await collections.getDiscordPosts(guild).add(postDoc);
    console.log(
      `📝 Created new Discord post document for guild ${guild}: ${docRef.id}`,
    );

    return docRef.id;
  } catch (error) {
    console.error("❌ Error creating Discord post:", error.message);
    throw error;
  }
}

/**
 * Request an update to an existing Discord post
 * @param {string} postId - Firestore document ID
 * @param {Object} updateData - Data to update
 * @param {string} guildId - Guild ID (optional, defaults to environment)
 */
export async function requestPostUpdate(postId, updateData, guildId = null) {
  try {
    const guild = guildId || getGuildId();

    await collections
      .getDiscordPosts(guild)
      .doc(postId)
      .update({
        ...updateData,
        updateRequested: true,
        updateRequestedAt: new Date(),
      });

    console.log(`🔄 Requested update for post in guild ${guild}: ${postId}`);
  } catch (error) {
    console.error("❌ Error requesting post update:", error.message);
    throw error;
  }
}

/**
 * Update reaction count for a post
 * @param {string} discordMessageId - Discord message ID
 * @param {string} emoji - Reaction emoji
 * @param {number} count - New reaction count
 * @param {string} guildId - Guild ID (optional, defaults to environment)
 */
export async function updateReactionCount(
  discordMessageId,
  emoji,
  count,
  guildId = null,
) {
  try {
    const guild = guildId || getGuildId();

    const querySnapshot = await collections
      .getDiscordPosts(guild)
      .where("discordMessageId", "==", discordMessageId)
      .get();

    if (querySnapshot.empty) {
      console.warn(
        `⚠️ No post found for Discord message in guild ${guild}: ${discordMessageId}`,
      );
      return;
    }

    const postDoc = querySnapshot.docs[0];
    const currentReactions = postDoc.data().reactions || {};

    await postDoc.ref.update({
      [`reactions.${emoji}`]: count,
      lastReactionUpdate: new Date(),
    });

    console.log(
      `✅ Updated reaction count for guild ${guild} - ${emoji}: ${count}`,
    );
  } catch (error) {
    console.error("❌ Error updating reaction count:", error.message);
    throw error;
  }
}

/**
 * Handle user signup for a roam when they react with ✅
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 * @param {string} guildId - Guild ID (optional, defaults to environment)
 */
export async function handleRoamSignup(
  discordMessageId,
  discordUserId,
  discordUsername = "Unknown",
  guildId = null,
) {
  try {
    const guild = guildId || getGuildId();

    // Get user document directly using Discord ID as document ID
    const userDoc = await collections
      .getGuildCollection(guild, "users")
      .doc(discordUserId)
      .get();

    let isRegisteredUser = false;
    let userData = null;

    if (userDoc.exists) {
      isRegisteredUser = true;
      userData = userDoc.data();
      console.log(
        `✅ Found registered user: ${userData.username || userData.displayName} (Discord ID: ${discordUserId})`,
      );
    } else {
      console.log(
        `👤 Guest user reaction from Discord user: ${discordUsername} (${discordUserId})`,
      );
    }

    // Get the discord post to find the roamId
    const postQuery = await collections
      .getDiscordPosts(guild)
      .where("discordMessageId", "==", discordMessageId)
      .get();

    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }

    const postData = postQuery.docs[0].data();
    const roamId = postData.roamId;

    if (!roamId) {
      console.warn(
        `⚠️ No roamId found in post for message: ${discordMessageId}`,
      );
      return;
    }

    // Get the roams document from guild-specific gameData collection
    const roamsDocRef = collections
      .getGuildCollection(guild, "gameData")
      .doc("roams");
    const roamsDoc = await roamsDocRef.get();

    if (!roamsDoc.exists) {
      console.error(`❌ Roams document not found in guild ${guild}`);
      return;
    }

    const roamsData = roamsDoc.data();
    const scheduledRoams = roamsData.scheduled || [];

    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex((r) => r.id === roamId);

    if (roamIndex === -1) {
      console.error(
        `❌ Roam ${roamId} not found in scheduled roams for guild ${guild}`,
      );
      return;
    }

    const roamData = scheduledRoams[roamIndex];

    // Check if roam has ended - prevent signups to past roams
    if (roamData.ended) {
      console.log(`⛔ Cannot sign up - roam ${roamId} has ended and is locked`);
      return;
    }

    const signups = roamData.signups || [];
    const guests = roamData.guests || [];

    if (isRegisteredUser) {
      // Handle registered user signup
      if (signups.includes(discordUserId)) {
        console.log(
          `ℹ️ User ${userData.username || userData.displayName} (${discordUserId}) already signed up for roam ${roamId}`,
        );
        return;
      }

      // Remove from guests if they were there (user got registered)
      const updatedGuests = guests.filter((guest) => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === "string" ? guest : guest.discordId;
        return guestId !== discordUserId;
      });

      if (updatedGuests.length !== guests.length) {
        console.log(
          `🔄 Moving user ${discordUserId} from guests to registered signups`,
        );
        roamData.guests = updatedGuests;
      } else {
        roamData.guests = guests;
      }

      // Add to registered signups
      signups.push(discordUserId);
      roamData.signups = signups;

      console.log(
        `✅ Registered user ${userData.username || userData.displayName} (${discordUserId}) signed up for roam ${roamId} (${signups.length} registered, ${roamData.guests.length} guests)`,
      );
    } else {
      // Handle guest signup
      const existingGuestIndex = guests.findIndex((guest) => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === "string" ? guest : guest.discordId;
        return guestId === discordUserId;
      });

      if (existingGuestIndex !== -1) {
        console.log(
          `ℹ️ Guest user ${discordUsername} (${discordUserId}) already in guests list for roam ${roamId}`,
        );
        return;
      }

      // Check if they're already in registered signups (shouldn't happen, but safety check)
      if (signups.includes(discordUserId)) {
        console.log(
          `ℹ️ User ${discordUserId} already in registered signups for roam ${roamId}`,
        );
        return;
      }

      // Add to guests with both ID and username
      const guestInfo = {
        discordId: discordUserId,
        discordUsername: discordUsername,
        addedAt: new Date(),
      };

      guests.push(guestInfo);
      roamData.guests = guests;
      roamData.signups = signups;

      console.log(
        `👤 Guest user ${discordUsername} (${discordUserId}) added to roam ${roamId} (${signups.length} registered, ${guests.length} guests)`,
      );
    }

    // Update the roam in the scheduled array
    scheduledRoams[roamIndex] = roamData;

    // Update the roams document
    await roamsDocRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date(),
    });
  } catch (error) {
    console.error("❌ Error handling roam signup:", error.message);
    throw error;
  }
}

/**
 * Handle user unsignup for a roam when they remove ✅ reaction
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 * @param {string} guildId - Guild ID (optional, defaults to environment)
 */
export async function handleRoamUnsignup(
  discordMessageId,
  discordUserId,
  discordUsername = "Unknown",
  guildId = null,
) {
  try {
    const guild = guildId || getGuildId();

    // Get user document directly using Discord ID as document ID
    const userDoc = await collections
      .getGuildCollection(guild, "users")
      .doc(discordUserId)
      .get();

    let isRegisteredUser = false;
    let userData = null;

    if (userDoc.exists) {
      isRegisteredUser = true;
      userData = userDoc.data();
      console.log(
        `✅ Found registered user for unsignup: ${userData.username || userData.displayName} (Discord ID: ${discordUserId})`,
      );
    } else {
      console.log(`👤 Guest user unsignup from Discord ID: ${discordUserId}`);
    }

    // Get the discord post to find the roamId
    const postQuery = await collections
      .getDiscordPosts(guild)
      .where("discordMessageId", "==", discordMessageId)
      .get();

    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }

    const postData = postQuery.docs[0].data();
    const roamId = postData.roamId;

    if (!roamId) {
      console.warn(
        `⚠️ No roamId found in post for message: ${discordMessageId}`,
      );
      return;
    }

    // Get the roams document from guild-specific gameData collection
    const roamsDocRef = collections
      .getGuildCollection(guild, "gameData")
      .doc("roams");
    const roamsDoc = await roamsDocRef.get();

    if (!roamsDoc.exists) {
      console.error(`❌ Roams document not found in guild ${guild}`);
      return;
    }

    const roamsData = roamsDoc.data();
    const scheduledRoams = roamsData.scheduled || [];

    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex((r) => r.id === roamId);

    if (roamIndex === -1) {
      console.error(
        `❌ Roam ${roamId} not found in scheduled roams for guild ${guild}`,
      );
      return;
    }

    const roamData = scheduledRoams[roamIndex];

    // Check if roam has ended - prevent unsignups from past roams
    if (roamData.ended) {
      console.log(`⛔ Cannot unsign - roam ${roamId} has ended and is locked`);
      return;
    }

    const signups = roamData.signups || [];
    const guests = roamData.guests || [];

    let wasRemoved = false;
    let removedFrom = "";

    if (isRegisteredUser) {
      // Try to remove from registered signups first
      const updatedSignups = signups.filter(
        (userId) => userId !== discordUserId,
      );
      if (updatedSignups.length !== signups.length) {
        roamData.signups = updatedSignups;
        wasRemoved = true;
        removedFrom = "registered signups";
        console.log(
          `➖ Registered user ${userData.username || userData.displayName} (${discordUserId}) removed from roam ${roamId} (${updatedSignups.length} registered, ${guests.length} guests)`,
        );
      }
    }

    // If not removed from registered signups (or if guest user), try removing from guests
    if (!wasRemoved) {
      const updatedGuests = guests.filter((guest) => {
        // Handle both old format (string) and new format (object)
        const guestId = typeof guest === "string" ? guest : guest.discordId;
        return guestId !== discordUserId;
      });

      if (updatedGuests.length !== guests.length) {
        roamData.guests = updatedGuests;
        wasRemoved = true;
        removedFrom = "guests";
        console.log(
          `➖ ${isRegisteredUser ? "User" : "Guest"} ${discordUserId} removed from guests for roam ${roamId} (${roamData.signups.length} registered, ${updatedGuests.length} guests)`,
        );
      }
    }

    // Check if user was actually signed up anywhere
    if (!wasRemoved) {
      console.log(
        `ℹ️ User ${discordUserId} was not signed up for roam ${roamId}`,
      );
      return;
    }

    // Update the roam in the scheduled array
    scheduledRoams[roamIndex] = roamData;

    // Update the roams document
    await roamsDocRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date(),
    });
  } catch (error) {
    console.error("❌ Error handling roam unsignup:", error.message);
    throw error;
  }
}

/**
 * Stop all Firestore listeners
 */
export function stopFirestoreListeners() {
  console.log("🛑 Stopping all Firestore listeners...");

  // Unsubscribe from all listeners
  unsubscribeListeners.forEach((unsubscribe) => {
    unsubscribe();
  });
  unsubscribeListeners = [];

  // Clear guild config listeners map
  guildConfigListeners.clear();

  console.log("✅ All Firestore listeners stopped");
}

/**
 * Handle self sign-up role assignment when user reacts with emoji
 * Implements queue system: first person in queue gets the role
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 * @param {number} roleIndex - Index of the role (0-based)
 * @param {string} guildId - Guild ID
 */
export async function handleSelfSignUpRoleAssignment(
  discordMessageId,
  discordUserId,
  discordUsername,
  roleIndex,
  guildId = null,
) {
  try {
    const guild = guildId || getGuildId();

    console.log(
      `🎯 Processing self sign-up role assignment for ${discordUsername} (${discordUserId}) - Role index: ${roleIndex}`,
    );

    // Get the discord post to find the roamId
    const postQuery = await collections
      .getDiscordPosts(guild)
      .where("discordMessageId", "==", discordMessageId)
      .get();

    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }

    const postDoc = postQuery.docs[0];
    const postData = postDoc.data();
    const roamId = postData.roamId;
    const compositionSlots = postData.compositionSlots || [];

    if (!roamId) {
      console.warn(
        `⚠️ No roamId found in post for message: ${discordMessageId}`,
      );
      return;
    }

    if (roleIndex >= compositionSlots.length) {
      console.warn(
        `⚠️ Role index ${roleIndex} out of bounds for composition with ${compositionSlots.length} slots`,
      );
      return;
    }

    // Get the roams document
    const roamsDocRef = collections
      .getGuildCollection(guild, "gameData")
      .doc("roams");
    const roamsDoc = await roamsDocRef.get();

    if (!roamsDoc.exists) {
      console.error(`❌ Roams document not found in guild ${guild}`);
      return;
    }

    const roamsData = roamsDoc.data();
    const scheduledRoams = roamsData.scheduled || [];

    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex((r) => r.id === roamId);

    if (roamIndex === -1) {
      console.error(
        `❌ Roam ${roamId} not found in scheduled roams for guild ${guild}`,
      );
      return;
    }

    const roamData = scheduledRoams[roamIndex];

    // Check if roam has ended
    if (roamData.ended) {
      console.log(
        `⛔ Cannot assign role - roam ${roamId} has ended and is locked`,
      );
      return;
    }

    // Initialize role queues if they don't exist
    if (!roamData.roleQueues) {
      roamData.roleQueues = {};
    }
    if (!roamData.roleAssignments) {
      roamData.roleAssignments = {};
    }

    // Get the slot details
    const slot = compositionSlots[roleIndex];
    const isCategory = slot.slotType === "category";

    // Create slot key matching frontend format
    const slotKey = isCategory
      ? `${roleIndex}-${slot.category}`
      : `${roleIndex}-${slot.role}`;

    // Check if user is already in ANY role queue (prevent multiple role signups)
    let userCurrentRole = null;
    for (const [key, queue] of Object.entries(roamData.roleQueues)) {
      if (queue && queue.includes(discordUserId)) {
        userCurrentRole = key;
        break;
      }
    }

    // If user already has a role and it's not this one, ignore the new reaction
    if (userCurrentRole && userCurrentRole !== slotKey) {
      console.log(
        `⛔ User ${discordUserId} already queued for role ${userCurrentRole}, ignoring reaction to role ${roleIndex + 1}`,
      );
      return; // Don't process this reaction
    }

    // Initialize queue for this role if it doesn't exist
    if (!roamData.roleQueues[slotKey]) {
      roamData.roleQueues[slotKey] = [];
    }

    // Check if user is already in this role's queue
    if (!roamData.roleQueues[slotKey].includes(discordUserId)) {
      // Add user to the queue
      roamData.roleQueues[slotKey].push(discordUserId);
      console.log(
        `➕ Added ${discordUserId} to queue for role ${roleIndex + 1}, position: ${roamData.roleQueues[slotKey].length}`,
      );
    } else {
      console.log(
        `ℹ️ ${discordUserId} already in queue for role ${roleIndex + 1}`,
      );
    }

    // Assign the first person in the queue to the role
    if (roamData.roleQueues[slotKey].length > 0) {
      const assignedUserId = roamData.roleQueues[slotKey][0];
      roamData.roleAssignments[slotKey] = assignedUserId;
      console.log(
        `✅ Role ${roleIndex + 1} assigned to: ${assignedUserId} (1st in queue of ${roamData.roleQueues[slotKey].length})`,
      );
    }

    // Ensure user is in signups or guests
    const signups = roamData.signups || [];
    const guests = roamData.guests || [];

    // Check if user is registered
    const userDoc = await collections
      .getGuildCollection(guild, "users")
      .doc(discordUserId)
      .get();
    const isRegisteredUser = userDoc.exists;

    if (isRegisteredUser) {
      // Add to signups if not already there
      if (!signups.includes(discordUserId)) {
        signups.push(discordUserId);
        roamData.signups = signups;
        console.log(`✅ Added registered user to signups: ${discordUserId}`);
      }

      // Remove from guests if they were there
      roamData.guests = guests.filter((guest) => {
        const guestId = typeof guest === "string" ? guest : guest.discordId;
        return guestId !== discordUserId;
      });
    } else {
      // Add to guests if not already there
      const existingGuestIndex = guests.findIndex((guest) => {
        const guestId = typeof guest === "string" ? guest : guest.discordId;
        return guestId === discordUserId;
      });

      if (existingGuestIndex === -1) {
        guests.push({
          discordId: discordUserId,
          discordUsername: discordUsername,
        });
        roamData.guests = guests;
        console.log(
          `✅ Added guest user: ${discordUsername} (${discordUserId})`,
        );
      }
    }

    // Update the roam
    scheduledRoams[roamIndex] = roamData;

    await roamsDocRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date(),
    });

    const roleName = isCategory ? `Any ${slot.category}` : slot.role;
    console.log(
      `✅ Self sign-up: ${discordUsername} (${discordUserId}) queued for role ${roleIndex + 1}: ${roleName}`,
    );

    // Update the Discord message to show the assignment
    await updateDiscordPostWithRoleAssignments(
      postDoc.id,
      roamData,
      compositionSlots,
      guild,
    );
  } catch (error) {
    console.error(
      "❌ Error handling self sign-up role assignment:",
      error.message,
    );
    throw error;
  }
}

/**
 * Handle self sign-up role unassignment when user removes reaction
 * Implements queue system: removes user from queue, next person gets the role
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {number} roleIndex - Index of the role (0-based)
 * @param {string} guildId - Guild ID
 */
export async function handleSelfSignUpRoleUnassignment(
  discordMessageId,
  discordUserId,
  roleIndex,
  guildId = null,
) {
  try {
    const guild = guildId || getGuildId();

    console.log(
      `🎯 Processing self sign-up role unassignment for ${discordUserId} - Role index: ${roleIndex}`,
    );

    // Get the discord post to find the roamId
    const postQuery = await collections
      .getDiscordPosts(guild)
      .where("discordMessageId", "==", discordMessageId)
      .get();

    if (postQuery.empty) {
      console.warn(`⚠️ No post found for Discord message: ${discordMessageId}`);
      return;
    }

    const postDoc = postQuery.docs[0];
    const postData = postDoc.data();
    const roamId = postData.roamId;
    const compositionSlots = postData.compositionSlots || [];

    if (!roamId) {
      console.warn(
        `⚠️ No roamId found in post for message: ${discordMessageId}`,
      );
      return;
    }

    if (roleIndex >= compositionSlots.length) {
      console.warn(
        `⚠️ Role index ${roleIndex} out of bounds for composition with ${compositionSlots.length} slots`,
      );
      return;
    }

    // Get the roams document
    const roamsDocRef = collections
      .getGuildCollection(guild, "gameData")
      .doc("roams");
    const roamsDoc = await roamsDocRef.get();

    if (!roamsDoc.exists) {
      console.error(`❌ Roams document not found in guild ${guild}`);
      return;
    }

    const roamsData = roamsDoc.data();
    const scheduledRoams = roamsData.scheduled || [];

    // Find the specific roam by ID
    const roamIndex = scheduledRoams.findIndex((r) => r.id === roamId);

    if (roamIndex === -1) {
      console.error(
        `❌ Roam ${roamId} not found in scheduled roams for guild ${guild}`,
      );
      return;
    }

    const roamData = scheduledRoams[roamIndex];

    // Initialize role queues if they don't exist
    if (!roamData.roleQueues) {
      roamData.roleQueues = {};
    }
    if (!roamData.roleAssignments) {
      roamData.roleAssignments = {};
    }

    // Get the slot details
    const slot = compositionSlots[roleIndex];
    const isCategory = slot.slotType === "category";

    // Create slot key matching frontend format
    const slotKey = isCategory
      ? `${roleIndex}-${slot.category}`
      : `${roleIndex}-${slot.role}`;

    // Initialize queue for this role if it doesn't exist
    if (!roamData.roleQueues[slotKey]) {
      roamData.roleQueues[slotKey] = [];
    }

    // Remove user from the queue
    const wasInQueue = roamData.roleQueues[slotKey].includes(discordUserId);
    roamData.roleQueues[slotKey] = roamData.roleQueues[slotKey].filter(
      (id) => id !== discordUserId,
    );

    if (!wasInQueue) {
      console.log(
        `ℹ️ User ${discordUserId} was not in queue for role ${roleIndex + 1}`,
      );
      return;
    }

    console.log(
      `➖ Removed ${discordUserId} from queue for role ${roleIndex + 1}`,
    );

    // Reassign role to the first person in the queue (if any)
    if (roamData.roleQueues[slotKey].length > 0) {
      const newAssignedUserId = roamData.roleQueues[slotKey][0];
      roamData.roleAssignments[slotKey] = newAssignedUserId;
      console.log(
        `🔄 Role ${roleIndex + 1} reassigned to next in queue: ${newAssignedUserId}`,
      );
    } else {
      // No one left in queue, remove assignment
      delete roamData.roleAssignments[slotKey];
      console.log(`➖ Role ${roleIndex + 1} now unassigned (queue empty)`);
    }

    const roleName = isCategory ? `Any ${slot.category}` : slot.role;

    // Update the roam
    scheduledRoams[roamIndex] = roamData;

    await roamsDocRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date(),
    });

    // Update the Discord message to show the new assignment
    await updateDiscordPostWithRoleAssignments(
      postDoc.id,
      roamData,
      compositionSlots,
      guild,
    );
  } catch (error) {
    console.error(
      "❌ Error handling self sign-up role unassignment:",
      error.message,
    );
    throw error;
  }
}

/**
 * Update Discord post description with current role assignments for self sign-up roams
 * @param {string} postDocId - Firestore post document ID
 * @param {Object} roamData - Roam data with roleAssignments
 * @param {Array} compositionSlots - Composition slots array
 * @param {string} guildId - Guild ID
 */
async function updateDiscordPostWithRoleAssignments(
  postDocId,
  roamData,
  compositionSlots,
  guildId,
) {
  try {
    // Trigger a Discord message update by setting updateRequested flag
    await collections.getDiscordPosts(guildId).doc(postDocId).update({
      updateRequested: true,
      lastRoleUpdate: new Date(),
    });

    console.log(`🔄 Triggered Discord message update for role assignments`);
  } catch (error) {
    console.error(
      "❌ Error updating Discord post with role assignments:",
      error.message,
    );
    // Don't throw - this is a nice-to-have feature
  }
}

export default {
  initializeFirestoreListeners,
  createDiscordPost,
  requestPostUpdate,
  updateReactionCount,
  handleRoamSignup,
  handleRoamUnsignup,
  handleSelfSignUpRoleAssignment,
  handleSelfSignUpRoleUnassignment,
  stopFirestoreListeners,
};
