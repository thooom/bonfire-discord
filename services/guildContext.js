/**
 * Guild context management for multi-tenant architecture
 */

/**
 * Get guild ID from various sources (request, env, default)
 * @param {Object} req - Express request object (optional)
 * @returns {string} - Guild ID
 */
export function getGuildId(req = null) {
  // Try to get guild ID from request (URL param, query, body)
  if (req) {
    // Check URL parameters first
    if (req.params && req.params.guildId) {
      return req.params.guildId;
    }
    
    // Check query parameters
    if (req.query && req.query.guildId) {
      return req.query.guildId;
    }
    
    // Check request body
    if (req.body && req.body.guildId) {
      return req.body.guildId;
    }
    
    // Check headers
    if (req.headers && req.headers['x-guild-id']) {
      return req.headers['x-guild-id'];
    }
  }
  
  // Fallback to default guild
  return process.env.DEFAULT_GUILD_ID || 'Bonfire';
}

/**
 * Validate if guild ID is allowed
 * @param {string} guildId - Guild ID to validate
 * @returns {boolean} - Whether guild is allowed
 */
export function isValidGuild(guildId) {
  if (!guildId) return false;
  
  // If no restriction is set, allow all guilds
  if (!process.env.ALLOWED_GUILDS) return true;
  
  const allowedGuilds = process.env.ALLOWED_GUILDS.split(',').map(g => g.trim());
  return allowedGuilds.includes(guildId);
}

/**
 * Express middleware to extract and validate guild context
 */
export function guildContextMiddleware(req, res, next) {
  const guildId = getGuildId(req);
  
  if (!isValidGuild(guildId)) {
    return res.status(400).json({
      error: 'Invalid or unauthorized guild',
      guildId: guildId
    });
  }
  
  // Attach guild ID to request for use in handlers
  req.guildId = guildId;
  
  console.log(`🏰 Request for guild: ${guildId}`);
  next();
}

/**
 * Get guild-specific Discord bot configuration
 * @param {string} guildId - Guild ID
 * @returns {Object} - Guild-specific configuration
 */
export function getGuildConfig(guildId) {
  // For now, return default config
  // In the future, this could return guild-specific settings
  return {
    guildId,
    channelId: process.env.DISCORD_CHANNEL_ID,
    botToken: process.env.DISCORD_TOKEN
  };
}

export default {
  getGuildId,
  isValidGuild,
  guildContextMiddleware,
  getGuildConfig
};