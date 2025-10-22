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

    // Load service account key
    const serviceAccountPath = path.join(process.cwd(), 'firebaseServiceAccount.json');
    
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error('Firebase service account file not found at: ' + serviceAccountPath);
    }

    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

    // Initialize Firebase Admin
    app = initializeApp({
      credential: cert(serviceAccount),
      // Add your Firebase project ID here if needed
      // projectId: 'your-project-id'
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
 * Collections helper functions
 */
export const collections = {
  // Add your collection names here
  DISCORD_POSTS: 'discord_posts',
  POST_REACTIONS: 'post_reactions',
  
  // Helper to get collection reference
  get: (collectionName) => getDb().collection(collectionName)
};

export default { initializeFirebase, getDb, collections };