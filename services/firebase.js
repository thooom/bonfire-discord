import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

let db = null;
let app = null;

/**
 * Initialize Firebase Admin SDK
 */
export function initializeFirebase() {
  try {
    // Check if already initialized
    if (app) {
      console.log('✅ Firebase already initialized');
      return db;
    }

    let credential;

    // Try multiple methods to get Firebase credentials
    
    // Method 1: Environment variables (preferred for production/deployment)
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      console.log('🔐 Using Firebase credentials from environment variables');
      
      credential = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
      });
    }
    // Method 2: Service account file (for local development)
    else {
      const serviceAccountPath = path.join(process.cwd(), 'firebaseServiceAccount.json');
      
      if (!fs.existsSync(serviceAccountPath)) {
        throw new Error(`Firebase service account file not found at: ${serviceAccountPath}
        
Available configuration methods:
1. Environment variables: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL
2. Service account file: firebaseServiceAccount.json in project root

Current working directory: ${process.cwd()}
Looking for file at: ${serviceAccountPath}`);
      }

      console.log('📄 Using Firebase service account file');
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      credential = cert(serviceAccount);
    }

    // Initialize Firebase Admin
    app = initializeApp({
      credential: credential,
      projectId: process.env.FIREBASE_PROJECT_ID || undefined
    });

    // Initialize Firestore
    db = getFirestore(app);
    
    console.log('✅ Firebase Admin initialized successfully');
    return db;

  } catch (error) {
    console.error('❌ Error initializing Firebase:', error.message);
    throw error;
  }
}

/**
 * Get Firestore database instance
 */
export function getDb() {
  if (!db) {
    throw new Error('Firebase not initialized. Call initializeFirebase() first.');
  }
  return db;
}

/**
 * Collections helper functions for multi-tenant architecture
 */
export const collections = {
  // Legacy collection names (deprecated)
  DISCORD_POSTS: 'discord_posts',
  POST_REACTIONS: 'post_reactions', 
  USERS: 'users',
  GAME_DATA: 'gameData',
  
  // Multi-tenant collection getters
  getGuildCollection: (guildId, collectionName) => {
    if (!guildId) {
      throw new Error('Guild ID is required for collection access');
    }
    return getDb().collection('guilds').doc(guildId).collection(collectionName);
  },
  
  // Guild-specific collection helpers
  getDiscordPosts: (guildId) => collections.getGuildCollection(guildId, 'discord_posts'),
  getUsers: (guildId) => collections.getGuildCollection(guildId, 'users'),
  getGameData: (guildId) => collections.getGuildCollection(guildId, 'gameData'),
  getRoams: (guildId) => collections.getGuildCollection(guildId, 'gameData').doc('roams'),
  
  // Guild settings and configuration
  getGuildDoc: (guildId) => getDb().collection('guilds').doc(guildId),
  getGuildSettings: (guildId) => collections.getGuildDoc(guildId),
  
  // Legacy helper (for backward compatibility during migration)
  get: (collectionName, guildId = null) => {
    if (guildId) {
      return collections.getGuildCollection(guildId, collectionName);
    }
    // Fallback to legacy pattern
    return getDb().collection(collectionName);
  }
};

export default { initializeFirebase, getDb, collections };