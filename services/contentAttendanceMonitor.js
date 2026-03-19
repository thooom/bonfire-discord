import { Events } from "discord.js";
import { getDiscordClient } from "./discordService.js";
import { collections, getDb } from "./firebase.js";
import { getGuildSettings } from "./guildSettings.js";

const activeAttendanceSessions = new Map(); // guildId -> { roamId, channelId, messageId, lastContent }
const roamsUnsubscribeByGuild = new Map();
let guildsUnsubscribe = null;
let initialized = false;

function parseContentChannelIds(discordChannels = {}) {
  const raw = discordChannels.contentChannels;

  if (Array.isArray(raw)) {
    return raw
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id) => /^\d{17,19}$/.test(id));
  }

  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{17,19}$/.test(id));
  }

  return [];
}

function getOngoingRoam(roams = []) {
  const now = new Date();

  const ongoing = roams
    .filter((roam) => {
      if (!roam || roam.ended) return false;
      const roamDateTime = new Date(`${roam.date}T${roam.time}`);
      if (Number.isNaN(roamDateTime.getTime())) return false;
      return now >= roamDateTime;
    })
    .sort((a, b) => {
      const dateA = new Date(`${a.date}T${a.time}`).getTime();
      const dateB = new Date(`${b.date}T${b.time}`).getTime();
      return dateB - dateA; // most recently started first
    });

  return ongoing[0] || null;
}

function extractExpectedParticipants(roamData = {}) {
  const assigned = Object.values(roamData.roleAssignments || {}).filter(Boolean);
  if (assigned.length > 0) {
    return [...new Set(assigned.map((id) => String(id)))];
  }

  const registered = Array.isArray(roamData.signups) ? roamData.signups : [];
  const guests = Array.isArray(roamData.guests) ? roamData.guests : [];

  const guestIds = guests
    .map((guest) => {
      if (typeof guest === "string") return guest;
      return guest?.discordId || guest?.id || null;
    })
    .filter(Boolean);

  return [...new Set([...registered, ...guestIds].map((id) => String(id)))];
}

async function resolveGuildIdByContentChannel(channelId) {
  const snapshot = await getDb()
    .collection("guilds")
    .where("discordChannels.contentChannels", "array-contains", channelId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const guildDoc = snapshot.docs[0];
  const guildData = guildDoc.data();
  if (guildData?.settings?.enableContentAttendance !== true) {
    return null;
  }

  return guildDoc.id;
}

function pickAttendanceTextChannelId(guildSettings = {}) {
  const channels = guildSettings.discordChannels || {};

  if (typeof channels.logs === "string" && /^\d{17,19}$/.test(channels.logs.trim())) {
    return channels.logs.trim();
  }

  if (typeof channels.events === "string" && /^\d{17,19}$/.test(channels.events.trim())) {
    return channels.events.trim();
  }

  if (Array.isArray(channels.events)) {
    const first = channels.events.find((entry) =>
      typeof entry?.id === "string" && /^\d{17,19}$/.test(entry.id.trim()),
    );
    if (first) {
      return first.id.trim();
    }
  }

  return null;
}

async function getParticipantsInContentChannels(discordGuild, contentChannelIds, expectedParticipants) {
  const expectedSet = new Set(expectedParticipants);
  const joined = new Set();

  for (const channelId of contentChannelIds) {
    try {
      const channel =
        discordGuild.channels.cache.get(channelId) ||
        (await discordGuild.channels.fetch(channelId));

      if (!channel || !channel.members) {
        continue;
      }

      channel.members.forEach((member) => {
        const memberId = String(member.id);
        if (expectedSet.has(memberId)) {
          joined.add(memberId);
        }
      });
    } catch (error) {
      console.warn(`⚠️ Could not fetch content channel ${channelId}: ${error.message}`);
    }
  }

  return joined;
}

function buildWaitingContent(roamData, missingParticipants) {
  const roamName = roamData?.title || roamData?.name || "Roam";
  const mentionList = missingParticipants.map((id) => `<@${id}>`).join(", ");

  return [
    `🎬 **Content is started** for **${roamName}**.`,
    `Still waiting for: ${mentionList}`,
  ].join("\n");
}

async function deleteAttendanceMessage(session, reason) {
  if (!session?.messageId || !session?.channelId) {
    return;
  }

  try {
    const client = getDiscordClient();
    if (!client || !client.isReady()) {
      return;
    }

    const channel = await client.channels.fetch(session.channelId);
    if (!channel) {
      return;
    }

    const message = await channel.messages.fetch(session.messageId);
    if (!message) {
      return;
    }

    await message.delete();
    console.log(`🗑️ Deleted content attendance post (${reason}) for roam ${session.roamId}`);
  } catch (error) {
    console.warn(`⚠️ Failed deleting content attendance post: ${error.message}`);
  }
}

async function clearAttendanceSession(guildId, reason = "completed") {
  const existing = activeAttendanceSessions.get(guildId);
  if (!existing) return;

  await deleteAttendanceMessage(existing, reason);
  activeAttendanceSessions.delete(guildId);
}

async function ensureRoamWatcher(guildId) {
  if (roamsUnsubscribeByGuild.has(guildId)) {
    return;
  }

  const unsubscribe = collections.getRoams(guildId).onSnapshot(async (snapshot) => {
    const session = activeAttendanceSessions.get(guildId);
    if (!session) return;

    if (!snapshot.exists) {
      await clearAttendanceSession(guildId, "roam data removed");
      return;
    }

    const roams = snapshot.data()?.scheduled || [];
    const trackedRoam = roams.find((roam) => roam.id === session.roamId);

    if (!trackedRoam || trackedRoam.ended) {
      await clearAttendanceSession(guildId, "roam ended");
    }
  });

  roamsUnsubscribeByGuild.set(guildId, unsubscribe);
}

async function syncAttendanceForGuild(guildId, discordGuild, options = {}) {
  const { allowCreate = true } = options;
  const guildSettings = await getGuildSettings(guildId);
  const featureEnabled = guildSettings?.settings?.enableContentAttendance === true;
  const contentChannelIds = parseContentChannelIds(guildSettings?.discordChannels || {});

  if (!featureEnabled || contentChannelIds.length === 0) {
    await clearAttendanceSession(guildId, "feature disabled");
    return;
  }

  const roamsDoc = await collections.getRoams(guildId).get();
  const scheduledRoams = roamsDoc.exists ? roamsDoc.data()?.scheduled || [] : [];
  const ongoingRoam = getOngoingRoam(scheduledRoams);

  if (!ongoingRoam) {
    await clearAttendanceSession(guildId, "no ongoing roam");
    return;
  }

  const expectedParticipants = extractExpectedParticipants(ongoingRoam);
  if (expectedParticipants.length === 0) {
    await clearAttendanceSession(guildId, "no participants");
    return;
  }

  const joinedSet = await getParticipantsInContentChannels(
    discordGuild,
    contentChannelIds,
    expectedParticipants,
  );

  const missingParticipants = expectedParticipants.filter((id) => !joinedSet.has(id));

  if (missingParticipants.length === 0) {
    await clearAttendanceSession(guildId, "everyone joined");
    return;
  }

  await ensureRoamWatcher(guildId);

  const nextContent = buildWaitingContent(ongoingRoam, missingParticipants);
  const existing = activeAttendanceSessions.get(guildId);

  // Replace session if we switched roams
  if (existing && existing.roamId !== ongoingRoam.id) {
    await clearAttendanceSession(guildId, "switched ongoing roam");
  }

  const refreshedExisting = activeAttendanceSessions.get(guildId);
  if (!refreshedExisting) {
    if (!allowCreate) {
      return;
    }

    const channelId = pickAttendanceTextChannelId(guildSettings);

    if (!channelId) {
      console.warn(`⚠️ No channel available to post attendance for guild ${guildId}`);
      return;
    }

    const textChannel = await discordGuild.channels.fetch(channelId);
    if (!textChannel || !textChannel.send) {
      console.warn(`⚠️ Attendance channel ${channelId} is not a text channel`);
      return;
    }

    const message = await textChannel.send(nextContent);
    activeAttendanceSessions.set(guildId, {
      guildId,
      roamId: ongoingRoam.id,
      channelId,
      messageId: message.id,
      lastContent: nextContent,
    });

    console.log(`📣 Created content attendance post for guild ${guildId} (roam ${ongoingRoam.id})`);
    return;
  }

  if (refreshedExisting.lastContent === nextContent) {
    return;
  }

  try {
    const textChannel = await discordGuild.channels.fetch(refreshedExisting.channelId);
    const message = await textChannel.messages.fetch(refreshedExisting.messageId);
    await message.edit(nextContent);

    refreshedExisting.lastContent = nextContent;
    activeAttendanceSessions.set(guildId, refreshedExisting);

    console.log(`🔄 Updated content attendance post for guild ${guildId}`);
  } catch (error) {
    console.warn(`⚠️ Could not edit attendance message, recreating: ${error.message}`);
    await clearAttendanceSession(guildId, "stale message");
    await syncAttendanceForGuild(guildId, discordGuild);
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const joinedChannelId = newState?.channelId || null;
    const leftChannelId = oldState?.channelId || null;
    const discordGuild = newState.guild || oldState.guild;
    if (!discordGuild) {
      return;
    }

    const joinedGuildId = joinedChannelId
      ? await resolveGuildIdByContentChannel(joinedChannelId)
      : null;
    const leftGuildId = leftChannelId
      ? await resolveGuildIdByContentChannel(leftChannelId)
      : null;

    // Start tracking when someone JOINS a configured content voice channel
    if (joinedGuildId) {
      await syncAttendanceForGuild(joinedGuildId, discordGuild, { allowCreate: true });
    }

    // Keep an existing session accurate for leave/move events, but don't create a new one
    if (leftGuildId && leftGuildId !== joinedGuildId) {
      await syncAttendanceForGuild(leftGuildId, discordGuild, { allowCreate: false });
    }
  } catch (error) {
    console.error(`❌ Error in voice attendance update: ${error.message}`);
  }
}

async function setupGuildWatcher() {
  if (guildsUnsubscribe) {
    return;
  }

  guildsUnsubscribe = getDb().collection("guilds").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === "removed") {
        const guildId = change.doc.id;
        const unsubscribe = roamsUnsubscribeByGuild.get(guildId);
        if (unsubscribe) {
          unsubscribe();
          roamsUnsubscribeByGuild.delete(guildId);
        }
        await clearAttendanceSession(guildId, "guild removed");
      }

      if (change.type === "modified") {
        const guildId = change.doc.id;
        const guildData = change.doc.data();
        const enabled = guildData?.settings?.enableContentAttendance === true;
        const hasChannels = parseContentChannelIds(guildData?.discordChannels || {}).length > 0;

        if (!enabled || !hasChannels) {
          await clearAttendanceSession(guildId, "feature disabled");
        }
      }
    });
  });
}

export async function initializeContentAttendanceMonitoring() {
  const client = getDiscordClient();
  if (!client || !client.isReady()) {
    console.error("❌ Discord client not available for content attendance monitoring");
    return;
  }

  if (initialized) {
    return;
  }

  initialized = true;
  client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
  await setupGuildWatcher();

  console.log("🎙️ Content attendance monitoring initialized");
}

export async function stopContentAttendanceMonitoring() {
  if (!initialized) return;

  const client = getDiscordClient();
  if (client) {
    client.off(Events.VoiceStateUpdate, handleVoiceStateUpdate);
  }

  if (guildsUnsubscribe) {
    guildsUnsubscribe();
    guildsUnsubscribe = null;
  }

  for (const [, unsubscribe] of roamsUnsubscribeByGuild) {
    unsubscribe();
  }
  roamsUnsubscribeByGuild.clear();

  for (const [guildId] of activeAttendanceSessions) {
    await clearAttendanceSession(guildId, "monitor stopped");
  }

  initialized = false;
}

export default {
  initializeContentAttendanceMonitoring,
  stopContentAttendanceMonitoring,
};