import { collections } from './firebase.js';

/**
 * In-memory cache for Discord ID to Firebase ID mappings
 */
class UserCache {
  constructor() {
    this.cache = new Map(); // discordId -> { firebaseId, username, lastUpdated }
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get Firebase user ID from Discord ID (with caching)
   */
  async getFirebaseUserId(discordId) {
    // Check cache first
    const cached = this.cache.get(discordId);
    if (cached && (Date.now() - cached.lastUpdated) < this.cacheTimeout) {
      console.log(`📋 Cache hit for Discord user ${discordId} -> ${cached.firebaseId}`);
      return {
        firebaseId: cached.firebaseId,
        username: cached.username,
        fromCache: true
      };
    }

    // Cache miss - query Firestore
    console.log(`🔍 Cache miss - querying Firestore for Discord user ${discordId}`);
    
    try {
      const userQuery = await collections.get('users')
        .where('id', '==', discordId)
        .limit(1)
        .get();
      
      if (userQuery.empty) {
        return null;
      }

      const userDoc = userQuery.docs[0];
      const userData = userDoc.data();
      
      // Update cache
      this.cache.set(discordId, {
        firebaseId: userDoc.id,
        username: userData.username,
        lastUpdated: Date.now()
      });

      console.log(`💾 Cached user mapping: ${discordId} -> ${userDoc.id}`);

      return {
        firebaseId: userDoc.id,
        username: userData.username,
        fromCache: false
      };

    } catch (error) {
      console.error('❌ Error querying user:', error);
      return null;
    }
  }

  /**
   * Clear cache (useful for testing or memory management)
   */
  clearCache() {
    this.cache.clear();
    console.log('🧹 User cache cleared');
  }

  /**
   * Remove expired entries
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    
    for (const [discordId, data] of this.cache.entries()) {
      if ((now - data.lastUpdated) > this.cacheTimeout) {
        this.cache.delete(discordId);
        removed++;
      }
    }
    
    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} expired cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.entries()).map(([discordId, data]) => ({
        discordId,
        firebaseId: data.firebaseId,
        username: data.username,
        age: Date.now() - data.lastUpdated
      }))
    };
  }
}

// Export singleton instance
export const userCache = new UserCache();

// Cleanup expired entries every 10 minutes
setInterval(() => {
  userCache.cleanup();
}, 10 * 60 * 1000);

export default userCache;