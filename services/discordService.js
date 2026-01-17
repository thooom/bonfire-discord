import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { collections } from "./firebase.js";
import { getDiscordChannelId, isAutoPostingEnabled } from "./guildSettings.js";

let client = null;
let defaultChannelId = null;

/**
 * Generate unique emoji for each role index
 * Uses numbers (1-10) and letters (A-Z) for up to 36 unique roles
 * @param {number} index - Role index (0-based)
 * @returns {string} - Emoji string
 */
function getRoleEmoji(index) {
  const numberEmojis = [
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
    "🔟",
  ];
  const letterEmojis = [
    "🇦",
    "🇧",
    "🇨",
    "🇩",
    "🇪",
    "🇫",
    "🇬",
    "🇭",
    "🇮",
    "🇯",
    "🇰",
    "🇱",
    "🇲",
    "🇳",
    "🇴",
    "🇵",
    "🇶",
    "🇷",
    "🇸",
    "🇹",
    "🇺",
    "🇻",
    "🇼",
    "🇽",
    "🇾",
    "🇿",
  ];

  if (index < 10) {
    return numberEmojis[index];
  } else if (index < 36) {
    return letterEmojis[index - 10];
  } else {
    // Fallback for more than 36 roles
    return "⭐";
  }
}

/**
 * Get emoji index from emoji string
 * @param {string} emoji - Emoji string
 * @returns {number} - Index (0-based) or -1 if not found
 */
function getEmojiIndex(emoji) {
  const numberEmojis = [
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
    "🔟",
  ];
  const letterEmojis = [
    "🇦",
    "🇧",
    "🇨",
    "🇩",
    "🇪",
    "🇫",
    "🇬",
    "🇭",
    "🇮",
    "🇯",
    "🇰",
    "🇱",
    "🇲",
    "🇳",
    "🇴",
    "🇵",
    "🇶",
    "🇷",
    "🇸",
    "🇹",
    "🇺",
    "🇻",
    "🇼",
    "🇽",
    "🇾",
    "🇿",
  ];

  const numberIndex = numberEmojis.indexOf(emoji);
  if (numberIndex !== -1) return numberIndex;

  const letterIndex = letterEmojis.indexOf(emoji);
  if (letterIndex !== -1) return letterIndex + 10;

  return -1;
}

/**
 * Initialize Discord bot client
 */
export function initializeDiscordBot() {
  return new Promise((resolve, reject) => {
    try {
      defaultChannelId = process.env.DISCORD_CHANNEL_ID;

      if (!defaultChannelId) {
        console.warn(
          "⚠️ DISCORD_CHANNEL_ID environment variable not set, will use guild-specific channels",
        );
      }

      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
      });

      // Bot ready event
      client.once(Events.ClientReady, () => {
        console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
        console.log(
          `📊 Connected to ${client.guilds.cache.size} Discord server(s):`,
        );
        client.guilds.cache.forEach((guild) => {
          console.log(
            `   🏰 ${guild.name} (ID: ${guild.id}) - ${guild.memberCount} members`,
          );
          console.log(`      📺 Available text channels:`);
          guild.channels.cache
            .filter((channel) => channel.type === 0) // Text channels
            .forEach((channel) => {
              console.log(`         #${channel.name} (ID: ${channel.id})`);
            });
        });
        resolve(client);
      });

      // Login with bot token
      client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
      console.error("❌ Error initializing Discord bot:", error.message);
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
      throw new Error("Discord bot is not ready");
    }

    // Get guild-specific channel for events
    const channelId = await getDiscordChannelId(guildId, "events");

    if (!channelId) {
      throw new Error(`No events channel configured for guild: ${guildId}`);
    }

    console.log(`📤 Posting to Discord for guild: ${guildId}`);
    console.log(`   📺 Channel ID: ${channelId}`);

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Could not find channel with ID: ${channelId}`);
    }

    console.log(
      `   ✅ Channel found: ${channel.name} (${channel.guild?.name || "Unknown Server"})`,
    );

    // Check if auto posting is enabled for this guild
    const autoPostEnabled = await isAutoPostingEnabled(guildId, "events");
    if (!autoPostEnabled) {
      console.log(
        `⚠️ Auto event posting disabled for guild ${guildId}, skipping post`,
      );
      return null;
    }

    // Create the message content
    const messageContent = formatPostMessage(postData);

    // Send the message
    const message = await channel.send(messageContent);

    // Add reactions based on post type
    if (
      postData.selfSignUp &&
      postData.compositionSlots &&
      postData.compositionSlots.length > 0
    ) {
      // Self sign-up mode: add unique emoji for each role
      console.log(
        `🎯 Self sign-up mode: adding ${postData.compositionSlots.length} unique role reactions`,
      );

      for (let i = 0; i < postData.compositionSlots.length; i++) {
        try {
          const emoji = getRoleEmoji(i);
          await message.react(emoji);
          console.log(`   ✅ Added reaction ${i + 1}: ${emoji}`);
        } catch (reactionError) {
          console.error(
            `   ❌ Failed to add reaction for role ${i + 1}:`,
            reactionError.message,
          );
        }
      }
    } else {
      // Regular mode: add ✅ reaction for signup
      await message.react("✅");
      console.log(`   ✅ Added ✅ reaction for regular signup`);
    }

    console.log(`📤 Posted message to Discord: ${message.id}`);

    // Return message metadata
    return {
      messageId: message.id,
      channelId: message.channel.id,
      timestamp: message.createdTimestamp,
      url: message.url,
    };
  } catch (error) {
    console.error("❌ Error posting to Discord:", error.message);
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
      throw new Error("Discord bot is not ready");
    }

    // Get guild-specific channel for events
    const channelId = await getDiscordChannelId(guildId, "events");

    if (!channelId) {
      throw new Error(`No events channel configured for guild: ${guildId}`);
    }

    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);

    if (!message) {
      throw new Error(`Could not find message with ID: ${messageId}`);
    }

    // If this is a selfSignUp roam, fetch the roam data to get roleAssignments
    let roamData = null;
    if (updatedData.selfSignUp && updatedData.roamId) {
      try {
        const { collections } = await import("./firebase.js");
        const roamsDoc = await collections
          .getGuildCollection(guildId, "gameData")
          .doc("roams")
          .get();
        if (roamsDoc.exists) {
          const roamsData = roamsDoc.data();
          const scheduledRoams = roamsData.scheduled || [];
          roamData = scheduledRoams.find((r) => r.id === updatedData.roamId);
        }
      } catch (error) {
        console.warn(
          "⚠️ Could not fetch roam data for role assignments:",
          error.message,
        );
      }
    }

    const updatedContent = formatPostMessage(updatedData, roamData);
    await message.edit(updatedContent);

    // Update reactions if selfSignUp mode changed or slots changed
    if (
      updatedData.selfSignUp &&
      updatedData.compositionSlots &&
      updatedData.compositionSlots.length > 0
    ) {
      // Self sign-up mode: ensure all role emojis are present
      console.log(
        `🎯 Updating self sign-up reactions for ${updatedData.compositionSlots.length} roles`,
      );

      // Check which reactions already exist
      const existingReactions = message.reactions.cache.map(
        (r) => r.emoji.name,
      );

      // Add missing role reactions
      for (let i = 0; i < updatedData.compositionSlots.length; i++) {
        const emoji = getRoleEmoji(i);
        if (!existingReactions.includes(emoji)) {
          try {
            await message.react(emoji);
            console.log(`   ✅ Added missing reaction ${i + 1}: ${emoji}`);
          } catch (reactionError) {
            console.error(
              `   ❌ Failed to add reaction for role ${i + 1}:`,
              reactionError.message,
            );
          }
        }
      }
    }

    console.log(
      `📝 Updated Discord message: ${messageId} for guild ${guildId}`,
    );
    return message;
  } catch (error) {
    console.error("❌ Error updating Discord message:", error.message);
    throw error;
  }
}

/**
 * Format post data into Discord message content
 * @param {Object} postData - Post data from Firestore
 * @returns {string} - Formatted message content
 */
function formatPostMessage(postData, roamData = null) {
  const {
    title = "New Post",
    description = "",
    author = "Anonymous",
    timestamp,
    reactions = {},
    additionalInfo = "",
    roamId = null,
    roamDetails = null,
    selfSignUp = false,
    compositionSlots = [],
  } = postData;

  // If this is a selfSignUp roam with roamData, format it specially
  if (selfSignUp && roamData && compositionSlots.length > 0) {
    const roleAssignments = roamData.roleAssignments || {};
    const roleQueues = roamData.roleQueues || {};

    let message = `**${title}**\n\n`;
    message += `🎯 **React to claim your role!**\n\n`;

    // Add each role with its emoji and assignment
    compositionSlots.forEach((slot, index) => {
      const emoji = getRoleEmoji(index);
      const isCategory = slot.slotType === "category";
      const slotKey = isCategory
        ? `${index}-${slot.category}`
        : `${index}-${slot.role}`;

      let roleName;
      if (isCategory) {
        roleName = `Any ${slot.category}`;
      } else {
        // Use buildName if available, with buildUrl for link
        if (slot.buildName && slot.buildUrl) {
          roleName = `[${slot.buildName}](${slot.buildUrl})`;
        } else if (slot.buildName) {
          roleName = slot.buildName;
        } else {
          roleName = slot.role;
        }
      }

      const assignedUserId = roleAssignments[slotKey];
      const queue = roleQueues[slotKey] || [];

      if (assignedUserId) {
        message += `${emoji} ${roleName} - <@${assignedUserId}>`;
        if (queue.length > 1) {
          message += ` (${queue.length - 1} in queue)`;
        }
        message += `\n`;
      } else {
        message += `${emoji} ${roleName} -`;
        if (queue.length > 0) {
          message += ` (${queue.length} in queue)`;
        }
        message += `\n`;
      }
    });

    if (description && !description.includes("React to claim your role")) {
      message += `\n${description}`;
    }

    return message;
  }

  // Regular (non-selfSignUp) format
  let message = `**${title}**\n`;

  if (description) {
    message += `${description}\n`;
  }

  // Add roam information if available
  if (roamId && roamDetails) {
    message += `\n🗡️ **Roam ID:** ${roamId}`;
    if (roamDetails.type) message += `\n📋 **Type:** ${roamDetails.type}`;
    if (roamDetails.datetime)
      message += `\n⏰ **Time:** ${roamDetails.datetime}`;
    if (roamDetails.leader) message += `\n👑 **Leader:** ${roamDetails.leader}`;
    if (roamDetails.description)
      message += `\n📝 **Details:** ${roamDetails.description}`;
  } else if (roamId) {
    message += `\n🗡️ **Roam ID:** ${roamId}`;
  }

  message += `\n\n*Posted by: ${author}*`;

  if (timestamp) {
    message += `\n*Time: ${new Date(timestamp).toLocaleString()}*`;
  }

  // Add reaction count if there are reactions
  const reactionCount = reactions["✅"] || 0;
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
 * Delete a Discord message
 * @param {string} messageId - Discord message ID
 * @param {string} channelId - Discord channel ID
 * @returns {Promise<boolean>} - True if deleted successfully
 */
export async function deleteDiscordMessage(messageId, channelId) {
  try {
    if (!client) {
      throw new Error("Discord client not initialized");
    }

    console.log(
      `🗑️ Attempting to delete Discord message: ${messageId} in channel: ${channelId}`,
    );

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const message = await channel.messages.fetch(messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    await message.delete();
    console.log(`✅ Successfully deleted Discord message: ${messageId}`);
    return true;
  } catch (error) {
    console.error("❌ Error deleting Discord message:", error.message);
    throw error;
  }
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
  deleteDiscordMessage,
  getDiscordClient,
  getRoleEmoji,
  getEmojiIndex,
};
