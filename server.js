// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Import our modular services
import { initializeFirebase } from './services/firebase.js';
import { initializeDiscordBot } from './services/discordService.js';
import { initializeFirestoreListeners } from './services/firestoreListeners.js';
import { initializeReactionMonitoring } from './services/reactionMonitor.js';

dotenv.config();
const app = express();

// ====== EXPRESS BACKEND ======
app.use(cors({
  origin: [
    'https://bonfire-albion.web.app',
    'https://bonfire-7e85b.web.app',
    'http://localhost:3000',
    'http://localhost:3001'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Import routes
import authRoutes from './routes/authRoutes.js';
import discordRoutes from './routes/discordRoutes.js';

// Use routes
app.use('/api/auth', authRoutes);
app.use('/api/discord', discordRoutes);

app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    services: {
      firebase: "connected",
      discord: "connected",
      listeners: "active"
    }
  });
});

app.get("/api/info", (req, res) => {
  res.json({
    name: "Bonfire Discord Bot",
    version: "3.0.0",
    mode: "database-driven",
    description: "Backend listens to Firestore and manages Discord integration automatically",
    features: [
      "Auto-post to Discord from Firestore",
      "Real-time reaction monitoring",
      "Automatic message updates",
      "Database-driven architecture"
    ]
  });
});

const PORT = process.env.PORT || 5000;

// ====== INITIALIZE ALL SERVICES ======
async function initializeServices() {
  try {
    console.log('🚀 Starting Bonfire Discord Bot...');
    
    // 1. Initialize Firebase/Firestore
    console.log('📊 Initializing Firebase...');
    await initializeFirebase();
    
    // 2. Initialize Discord bot
    console.log('🤖 Initializing Discord bot...');
    await initializeDiscordBot();
    
    // 3. Set up Firestore listeners
    console.log('👂 Setting up Firestore listeners...');
    initializeFirestoreListeners();
    
    // 4. Set up Discord reaction monitoring
    console.log('👀 Setting up reaction monitoring...');
    initializeReactionMonitoring();
    
    console.log('✅ All services initialized successfully!');
    console.log('🎯 Backend is now listening for database changes and Discord reactions');
    
  } catch (error) {
    console.error('❌ Failed to initialize services:', error.message);
    process.exit(1);
  }
}

// Start the server
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🌐 Backend running on http://0.0.0.0:${PORT}`);
  
  // Initialize all services after server starts
  await initializeServices();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});
