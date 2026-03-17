import {
  getDiscordClient,
  postToDiscord,
  updateDiscordMessage,
} from "./discordService.js";
import { collections, getDb } from "./firebase.js";
import { getGuildId } from "./guildContext.js";
import { getGuildSettings } from "./guildSettings.js";
import { postRoamSummary, updateRoamSummary } from "./roamSummaryService.js";

let unsubscribeListeners = [];
let guildConfigListeners = new Map(); // Track guild config listeners

const userPriorityCache = new Map(); // `${discordGuildId}:${discordUserId}:${configSignature}` -> priority level

/**
 * Get normalized per-guild priority role settings.
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object>} - Priority configuration
 */
async function getPriorityRoleConfig(guildId) {
  try {
    const guildSettings = await getGuildSettings(guildId);
    const normalizeRoleName = (roleName) =>
      roleName.replace(/^@+/, "").trim().toLowerCase();

    const highPriorityRoles = Array.isArray(guildSettings?.settings?.highPriorityRoles)
      ? guildSettings.settings.highPriorityRoles
          .map((role) => (typeof role === "string" ? normalizeRoleName(role) : ""))
          .filter(Boolean)
      : [];
    const lowPriorityRoles = Array.isArray(guildSettings?.settings?.lowPriorityRoles)
      ? guildSettings.settings.lowPriorityRoles
          .map((role) => (typeof role === "string" ? normalizeRoleName(role) : ""))
          .filter(Boolean)
      : [];

    return {
      hasRules: highPriorityRoles.length > 0 || lowPriorityRoles.length > 0,
      highPriorityRoles,
      lowPriorityRoles,
      highPrioritySet: new Set(highPriorityRoles),
      lowPrioritySet: new Set(lowPriorityRoles),
      signature: `${highPriorityRoles.sort().join("|")}::${lowPriorityRoles.sort().join("|")}`,
    };
  } catch (error) {
    console.warn(
      `⚠️ Failed to load priority role config for guild ${guildId}: ${error.message}. Falling back to first-come-first-served`,
    );
    return {
      hasRules: false,
      highPriorityRoles: [],
      lowPriorityRoles: [],
      highPrioritySet: new Set(),
      lowPrioritySet: new Set(),
      signature: "",
    };
  }
}

/**
 * Determine user priority level based on per-guild Discord role settings.
 * @param {string} discordUserId - Discord user ID
 * @param {string|null} discordGuildId - Discord guild ID
 * @param {Object} priorityConfig - Priority configuration
 * @returns {Promise<string>} - "high" | "normal" | "low"
 */
async function getUserPriorityLevel(
  discordUserId,
  discordGuildId = null,
  priorityConfig = null,
) {
  if (!priorityConfig?.hasRules) {
    return "normal";
  }

  if (!discordGuildId) {
    console.log(
      `⚠️ No Discord guild ID available for ${discordUserId}; defaulting to normal priority`,
    );
    return "normal";
  }

  const cacheKey = `${discordGuildId}:${discordUserId}:${priorityConfig.signature}`;
  if (userPriorityCache.has(cacheKey)) {
    return userPriorityCache.get(cacheKey);
  }

  try {
    const client = getDiscordClient();
    if (!client || !client.isReady()) {
      console.log(
        `⚠️ Discord client not ready while resolving priority for ${discordUserId}; defaulting to normal priority`,
      );
      userPriorityCache.set(cacheKey, "normal");
      return "normal";
    }

    const guild = await client.guilds.fetch(discordGuildId);
    const member = await guild.members.fetch(discordUserId);

    const nonDefaultRoles = member.roles.cache.filter(
      (role) => role.id !== guild.id,
    );

    const roleNames = [...nonDefaultRoles.values()].map((role) =>
      role.name.toLowerCase(),
    );

    const hasHigh = roleNames.some((roleName) =>
      priorityConfig.highPrioritySet.has(roleName),
    );
    if (hasHigh) {
      userPriorityCache.set(cacheKey, "high");
      return "high";
    }

    const hasLow = roleNames.some((roleName) =>
      priorityConfig.lowPrioritySet.has(roleName),
    );
    if (hasLow) {
      userPriorityCache.set(cacheKey, "low");
      return "low";
    }

    userPriorityCache.set(cacheKey, "normal");
    return "normal";
  } catch (error) {
    console.warn(
      `⚠️ Could not resolve Discord roles for ${discordUserId}: ${error.message}. Defaulting to normal priority`,
    );
    userPriorityCache.set(cacheKey, "normal");
    return "normal";
  }
}

function getPriorityRank(level) {
  if (level === "high") return 2;
  if (level === "low") return 0;
  return 1;
}

/**
 * Insert a user into a queue using configured priority rules.
 * @param {Array<string>} queue - Queue array to mutate
 * @param {string} discordUserId - User to insert
 * @param {string} userPriorityLevel - Priority level of user being inserted
 * @param {string|null} discordGuildId - Discord guild ID
 * @param {Object} priorityConfig - Priority configuration
 */
async function insertIntoPriorityQueue(
  queue,
  discordUserId,
  userPriorityLevel,
  discordGuildId = null,
  priorityConfig = null,
) {
  const filteredQueue = queue.filter((userId) => userId !== discordUserId);
  queue.length = 0;
  queue.push(...filteredQueue);

  if (!priorityConfig?.hasRules) {
    queue.push(discordUserId);
    return;
  }

  const newUserRank = getPriorityRank(userPriorityLevel);

  let insertIndex = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const queuedUserId = queue[i];
    const queuedUserLevel = await getUserPriorityLevel(
      queuedUserId,
      discordGuildId,
      priorityConfig,
    );
    const queuedUserRank = getPriorityRank(queuedUserLevel);

    if (newUserRank > queuedUserRank) {
      insertIndex = i;
      break;
    }
  }

  queue.splice(insertIndex, 0, discordUserId);
}

/**
 * Remove all currently assigned users from every queue.
 * Ensures invariant: if user has a slot assignment, they cannot be queued anywhere.
 * @param {Object} roamData - Roam data containing roleAssignments and roleQueues
 */
function removeAssignedUsersFromAllQueues(roamData) {
  if (!roamData?.roleAssignments || !roamData?.roleQueues) {
    return;
  }

  const assignedUserIds = new Set(
    Object.values(roamData.roleAssignments).filter(Boolean),
  );

  if (assignedUserIds.size === 0) {
    return;
  }

  for (const queueKey of Object.keys(roamData.roleQueues)) {
    const queue = Array.isArray(roamData.roleQueues[queueKey])
      ? roamData.roleQueues[queueKey]
      : [];
    roamData.roleQueues[queueKey] = queue.filter(
      (userId) => !assignedUserIds.has(userId),
    );
  }
}

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

            // Only update Firestore if we got a valid response (auto-posting might be disabled)
            if (discordMessageData) {
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
            } else {
              // Auto-posting disabled, mark as skipped
              await collections
                .getDiscordPosts(guildId)
                .doc(docId)
                .update({
                  status: "skipped",
                  skippedReason: "Auto-posting disabled for this guild",
                  skippedAt: new Date(),
                });

              console.log(
                `⏭️ Skipped posting for guild ${guildId}: ${docId} (auto-posting disabled)`,
              );
            }
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

        // Ignore removed documents - they're handled by the delete listener
        if (change.type === "removed") {
          console.log(`🗑️ Document removed, skipping update handler`);
          return;
        }

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
            if (postData.discordMessageId && (postData.discordChannelId || postData.channelId)) {
              const { deleteDiscordMessage } =
                await import("./discordService.js");
              await deleteDiscordMessage(
                postData.discordMessageId,
                postData.discordChannelId || postData.channelId,
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

    // Check if the Discord message was deleted
    if (error.message.startsWith('DISCORD_MESSAGE_DELETED:')) {
      console.warn(`⚠️ Discord message was deleted externally, marking post as orphaned`);
      
      try {
        // Mark the post as orphaned (Discord message deleted but Firestore doc still exists)
        const orphanedUpdate = {
          status: 'orphaned',
          orphanedReason: 'Discord message deleted externally',
          orphanedAt: new Date(),
          updateRequested: false,
          _isInternalUpdate: false,
          discordMessageId: null, // Clear the old message ID
          discordUrl: null
        };
        
        await collections.getDiscordPosts(guildId).doc(docId).update(orphanedUpdate);
        console.log(`✅ Post ${docId} marked as orphaned - you can delete or re-post it from the UI`);
        return;
      } catch (updateError) {
        console.error(`❌ Failed to mark post ${docId} as orphaned:`, updateError.message);
        // Fall through to regular error handling
      }
    }

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

    // Check if this is a late sign-off (less than 1 hour from event time)
    if (roamData.eventTime) {
      const eventTime = new Date(roamData.eventTime);
      const currentTime = new Date();
      const minutesUntilEvent = (eventTime - currentTime) / 1000 / 60;

      if (minutesUntilEvent > 0 && minutesUntilEvent < 60) {
        console.log(`⚠️ Late sign-off detected: ${minutesUntilEvent.toFixed(1)} minutes until event`);
        
        // Initialize lateSignOff array if it doesn't exist
        if (!roamData.lateSignOff) {
          roamData.lateSignOff = [];
        }
        
        // Add user to lateSignOff if not already there
        if (!roamData.lateSignOff.includes(discordUserId)) {
          roamData.lateSignOff.push(discordUserId);
          console.log(`📝 Added ${discordUserId} to lateSignOff list`);
        }
      }
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
 * Supports multiple slots with the same emoji - assigns to first available slot
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {string} discordUsername - Discord username
 * @param {number} roleIndex - Index of the role (0-based) that was clicked
 * @param {string} guildId - Guild ID
 */
export async function handleSelfSignUpRoleAssignment(
  discordMessageId,
  discordUserId,
  discordUsername,
  roleIndex,
  guildId = null,
  discordGuildId = null,
) {
  try {
    const guild = guildId || getGuildId();
    const priorityConfig = await getPriorityRoleConfig(guild);

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

    // Get the emoji for the clicked slot
    const clickedSlot = compositionSlots[roleIndex];
    const clickedEmoji = clickedSlot.emoji || `default-${roleIndex}`;
    
    // Find ALL slots that share this emoji
    const slotsWithSameEmoji = [];
    for (let i = 0; i < compositionSlots.length; i++) {
      const slot = compositionSlots[i];
      const slotEmoji = slot.emoji || `default-${i}`;
      if (slotEmoji === clickedEmoji) {
        slotsWithSameEmoji.push({
          index: i,
          slot: slot,
          slotKey: slot.slotType === "category" 
            ? `${i}-${slot.category}` 
            : `${i}-${slot.role}`
        });
      }
    }
    
    console.log(`   📊 Found ${slotsWithSameEmoji.length} slot(s) with this emoji`);

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

    const userPriorityLevel = await getUserPriorityLevel(
      discordUserId,
      discordGuildId,
      priorityConfig,
    );
    console.log(
      `   🏷️ Priority for ${discordUsername} (${discordUserId}): ${userPriorityLevel.toUpperCase()}${priorityConfig.hasRules ? "" : " (rules disabled)"}`,
    );

    // Check if user is already assigned to ANY of these slots
    let userAlreadyInGroup = false;
    for (const slotInfo of slotsWithSameEmoji) {
      if (roamData.roleAssignments[slotInfo.slotKey] === discordUserId) {
        userAlreadyInGroup = true;
        console.log(`   ℹ️ User already assigned to slot ${slotInfo.index + 1}`);
        break;
      }
    }

    if (userAlreadyInGroup) {
      return; // User already has one of these slots
    }

    // Check if user is already in a DIFFERENT emoji group
    for (const [key, assignedUserId] of Object.entries(roamData.roleAssignments)) {
      if (assignedUserId === discordUserId) {
        const isInSameGroup = slotsWithSameEmoji.some(s => s.slotKey === key);
        if (!isInSameGroup) {
          console.log(
            `⛔ User ${discordUserId} already assigned to a different role (${key}), ignoring reaction`,
          );
          return;
        }
      }
    }

    // Find the first available slot from this emoji group
    let assignedSlotKey = null;
    for (const slotInfo of slotsWithSameEmoji) {
      if (!roamData.roleAssignments[slotInfo.slotKey]) {
        // This slot is empty - assign user here
        roamData.roleAssignments[slotInfo.slotKey] = discordUserId;
        assignedSlotKey = slotInfo.slotKey;
        console.log(
          `✅ Assigned ${discordUsername} to slot ${slotInfo.index + 1} (${slotInfo.slotKey})`,
        );
        break;
      }
    }

    if (!assignedSlotKey) {
      // All slots with this emoji are full - apply priority leapfrogging
      const firstSlotKey = slotsWithSameEmoji[0].slotKey;
      if (!roamData.roleQueues[firstSlotKey]) {
        roamData.roleQueues[firstSlotKey] = [];
      }

      let displacedUserId = null;
      let displacedSlotKey = null;

      if (priorityConfig.hasRules) {
        const newUserRank = getPriorityRank(userPriorityLevel);
        for (const slotInfo of slotsWithSameEmoji) {
          const currentAssignedUserId = roamData.roleAssignments[slotInfo.slotKey];
          if (!currentAssignedUserId) {
            continue;
          }

          const currentAssignedLevel = await getUserPriorityLevel(
            currentAssignedUserId,
            discordGuildId,
            priorityConfig,
          );
          const currentAssignedRank = getPriorityRank(currentAssignedLevel);

          if (newUserRank > currentAssignedRank) {
            displacedUserId = currentAssignedUserId;
            displacedSlotKey = slotInfo.slotKey;
            break;
          }
        }
      }

      if (displacedUserId && displacedSlotKey) {
        roamData.roleAssignments[displacedSlotKey] = discordUserId;
        assignedSlotKey = displacedSlotKey;

        const displacedUserLevel = await getUserPriorityLevel(
          displacedUserId,
          discordGuildId,
          priorityConfig,
        );

        await insertIntoPriorityQueue(
          roamData.roleQueues[firstSlotKey],
          displacedUserId,
          displacedUserLevel,
          discordGuildId,
          priorityConfig,
        );

        roamData.roleQueues[firstSlotKey] = roamData.roleQueues[firstSlotKey].filter(
          (id) => id !== discordUserId,
        );

        console.log(
          `⚡ Priority leapfrog: ${discordUsername} took slot from ${displacedUserId}; displaced user moved to queue`,
        );
      } else {
        await insertIntoPriorityQueue(
          roamData.roleQueues[firstSlotKey],
          discordUserId,
          userPriorityLevel,
          discordGuildId,
          priorityConfig,
        );

        const queuePosition =
          roamData.roleQueues[firstSlotKey].indexOf(discordUserId) + 1;

        console.log(
          `📋 All ${slotsWithSameEmoji.length} slots full - added ${discordUsername} to queue (position ${queuePosition})`,
        );
      }
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

    // If user was previously flagged for late sign-off, remove warning only when they get an actual slot
    if (assignedSlotKey && Array.isArray(roamData.lateSignOff)) {
      const previousLength = roamData.lateSignOff.length;
      roamData.lateSignOff = roamData.lateSignOff.filter(
        (userId) => userId !== discordUserId,
      );
      if (roamData.lateSignOff.length !== previousLength) {
        console.log(`✅ Cleared late sign-off warning for ${discordUserId} after assignment to slot`);
      }
    }

    removeAssignedUsersFromAllQueues(roamData);

    // Update the roam
    scheduledRoams[roamIndex] = roamData;

    await roamsDocRef.update({
      scheduled: scheduledRoams,
      lastUpdated: new Date(),
    });

    // Get slot info for logging
    const assignedSlot = slotsWithSameEmoji.find(s => s.slotKey === assignedSlotKey) || slotsWithSameEmoji[0];
    const isCategory = assignedSlot.slot.slotType === "category";
    const roleName = isCategory ? `Any ${assignedSlot.slot.category}` : assignedSlot.slot.role;
    
    console.log(
      `✅ Self sign-up: ${discordUsername} (${discordUserId}) assigned/queued for: ${roleName}`,
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
 * Supports multiple slots with same emoji - shifts users up when someone leaves
 * @param {string} discordMessageId - Discord message ID
 * @param {string} discordUserId - Discord user ID
 * @param {number} roleIndex - Index of the role (0-based) that was clicked
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

    // Get the emoji for the clicked slot
    const clickedSlot = compositionSlots[roleIndex];
    const clickedEmoji = clickedSlot.emoji || `default-${roleIndex}`;
    
    // Find ALL slots that share this emoji
    const slotsWithSameEmoji = [];
    for (let i = 0; i < compositionSlots.length; i++) {
      const slot = compositionSlots[i];
      const slotEmoji = slot.emoji || `default-${i}`;
      if (slotEmoji === clickedEmoji) {
        slotsWithSameEmoji.push({
          index: i,
          slot: slot,
          slotKey: slot.slotType === "category" 
            ? `${i}-${slot.category}` 
            : `${i}-${slot.role}`
        });
      }
    }
    
    console.log(`   📊 Found ${slotsWithSameEmoji.length} slot(s) with this emoji`);

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

    // Find which slot the user is currently assigned to
    let userSlotIndex = -1;
    for (const slotInfo of slotsWithSameEmoji) {
      if (roamData.roleAssignments[slotInfo.slotKey] === discordUserId) {
        userSlotIndex = slotsWithSameEmoji.indexOf(slotInfo);
        delete roamData.roleAssignments[slotInfo.slotKey];
        console.log(`   ➖ Removed ${discordUserId} from slot ${slotInfo.index + 1}`);
        break;
      }
    }

    if (userSlotIndex === -1) {
      console.log(`   ℹ️ User ${discordUserId} was not assigned to any of these slots`);
      // Remove from queue if present
      const firstSlotKey = slotsWithSameEmoji[0].slotKey;
      if (roamData.roleQueues[firstSlotKey]) {
        roamData.roleQueues[firstSlotKey] = roamData.roleQueues[firstSlotKey].filter(
          (id) => id !== discordUserId
        );
      }
    } else {
      // User was assigned - now shift everyone up
      console.log(`   🔄 Shifting users up from slot ${userSlotIndex + 1}...`);
      
      // Shift all users in subsequent slots up by one
      for (let i = userSlotIndex; i < slotsWithSameEmoji.length - 1; i++) {
        const currentSlot = slotsWithSameEmoji[i];
        const nextSlot = slotsWithSameEmoji[i + 1];
        
        if (roamData.roleAssignments[nextSlot.slotKey]) {
          // Move user from next slot to current slot
          roamData.roleAssignments[currentSlot.slotKey] = roamData.roleAssignments[nextSlot.slotKey];
          delete roamData.roleAssignments[nextSlot.slotKey];
          console.log(`     ⬆️ Moved user from slot ${nextSlot.index + 1} to slot ${currentSlot.index + 1}`);
        }
      }
      
      // Fill the last slot from queue if available
      const firstSlotKey = slotsWithSameEmoji[0].slotKey;
      const lastSlot = slotsWithSameEmoji[slotsWithSameEmoji.length - 1];
      
      if (!roamData.roleQueues[firstSlotKey]) {
        roamData.roleQueues[firstSlotKey] = [];
      }
      
      if (roamData.roleQueues[firstSlotKey].length > 0) {
        const nextInQueue = roamData.roleQueues[firstSlotKey].shift();
        roamData.roleAssignments[lastSlot.slotKey] = nextInQueue;
        console.log(`     ✅ Filled last slot ${lastSlot.index + 1} from queue: ${nextInQueue}`);

        // If queued user was flagged for late sign-off, clear warning when they actually get a slot
        if (Array.isArray(roamData.lateSignOff)) {
          const previousLength = roamData.lateSignOff.length;
          roamData.lateSignOff = roamData.lateSignOff.filter(
            (userId) => userId !== nextInQueue,
          );
          if (roamData.lateSignOff.length !== previousLength) {
            console.log(`✅ Cleared late sign-off warning for ${nextInQueue} after queue promotion`);
          }
        }
      }
    }

    removeAssignedUsersFromAllQueues(roamData);

    // Check if user has any remaining reactions (is in any queue or has any role assignment)
    let hasAnyReaction = Object.values(roamData.roleAssignments).includes(
      discordUserId,
    );
    for (const queueKey of Object.keys(roamData.roleQueues)) {
      if (roamData.roleQueues[queueKey].includes(discordUserId)) {
        hasAnyReaction = true;
        break;
      }
    }

    // If user has no more reactions, remove them from signups/guests
    if (!hasAnyReaction) {
      console.log(`🗑️ User ${discordUserId} has no more reactions, removing from signups/guests`);
      
      // Check if this is a late sign-off (less than 1 hour from event time)
      const eventTimeStr = postData.eventTime || roamData.eventTime;
      
      if (eventTimeStr) {
        const eventTime = new Date(eventTimeStr);
        const currentTime = new Date();
        const minutesUntilEvent = (eventTime - currentTime) / 1000 / 60;

        if (minutesUntilEvent > 0 && minutesUntilEvent < 60) {
          console.log(`⚠️ Late sign-off detected: ${minutesUntilEvent.toFixed(1)} minutes until event`);
          
          // Initialize lateSignOff array if it doesn't exist
          if (!roamData.lateSignOff) {
            roamData.lateSignOff = [];
          }
          
          // Add user to lateSignOff if not already there
          if (!roamData.lateSignOff.includes(discordUserId)) {
            roamData.lateSignOff.push(discordUserId);
            console.log(`📝 Added ${discordUserId} to lateSignOff list`);
          }
        }
      }
      
      // Check if user exists in users collection (registered user)
      const userDoc = await collections
        .getGuildCollection(guild, "users")
        .doc(discordUserId)
        .get();
      
      const isRegisteredUser = userDoc.exists;
      
      if (isRegisteredUser) {
        // Remove from registered signups
        const signups = roamData.signups || [];
        roamData.signups = signups.filter((userId) => userId !== discordUserId);
        console.log(`➖ Removed ${discordUserId} from registered signups`);
      } else {
        // Remove from guests
        const guests = roamData.guests || [];
        roamData.guests = guests.filter((guest) => {
          const guestId = typeof guest === "string" ? guest : guest.discordId;
          return guestId !== discordUserId;
        });
        console.log(`➖ Removed ${discordUserId} from guests`);
      }
    }

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
