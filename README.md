# Bonfire Discord Bot Backend

A modular Discord bot backend that listens to Firestore database changes and automatically manages Discord integration.

## 🏗️ Architecture

**Database-Driven Flow:**
```
Frontend → Firestore → Backend Listeners → Discord → Reaction Monitoring → Firestore
```

- **Frontend**: Writes directly to Firestore (no API calls needed)
- **Backend**: Listens to database changes and handles Discord automatically
- **Discord**: Receives posts and reactions are monitored back to Firestore

## 📁 File Structure

```
├── server.js                          # Main server entry point
├── services/
│   ├── firebase.js                    # Firestore connection & initialization
│   ├── discordService.js              # Discord message posting & management
│   ├── firestoreListeners.js          # Database change listeners
│   └── reactionMonitor.js             # Discord reaction monitoring
├── routes/
│   └── discordRoutes.js               # API routes (optional - not needed for main flow)
├── .env.example                       # Environment variables template
└── firebaseServiceAccount.json        # Firebase service account (not in git)
```

## 🔄 How It Works

### 1. Frontend Creates Post
Frontend writes to Firestore collection `discord_posts`:
```javascript
{
  title: "My Post Title",
  description: "Post description",
  author: "Username",
  status: "pending",
  createdAt: new Date()
}
```

### 2. Backend Auto-Posts to Discord
Backend detects the new document and:
- Posts message to Discord
- Adds ✅ reaction automatically
- Updates document with Discord message ID

### 3. Frontend Updates Post
Frontend updates the document:
```javascript
{
  additionalInfo: "New information",
  updateRequested: true
}
```

### 4. Backend Auto-Updates Discord
Backend detects the update request and:
- Updates the Discord message
- Marks update as completed

### 5. Discord Reactions Sync to Database
When users react in Discord:
- Backend monitors ✅ reactions
- Updates reaction counts in Firestore
- Real-time sync between Discord and database

## 🔧 Environment Variables

Create `.env` file with:
```bash
DISCORD_TOKEN=your_bot_token_here
DISCORD_CHANNEL_ID=your_channel_id_here
PORT=5000
```

## 🚀 Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Firebase:**
   - Download `firebaseServiceAccount.json` from Firebase Console
   - Place in project root

3. **Configure Discord Bot:**
   - Create bot at https://discord.com/developers/applications
   - Get bot token and channel ID
   - Add to `.env` file

4. **Start server:**
   ```bash
   npm start
   ```

## 📊 Firestore Collections

### `discord_posts`
```javascript
{
  title: string,           // Post title
  description: string,     // Post description  
  author: string,          // Author name
  additionalInfo: string,  // Additional information for updates
  status: string,          // 'pending', 'posted', 'error', 'deleted'
  createdAt: timestamp,    // When created
  postedAt: timestamp,     // When posted to Discord
  discordMessageId: string,// Discord message ID
  discordChannelId: string,// Discord channel ID
  discordUrl: string,      // Discord message URL
  reactions: {             // Reaction counts
    '✅': number
  },
  updateRequested: boolean,// Whether update is requested
  lastUpdated: timestamp   // Last update time
}
```

## 🎯 Frontend Integration

Your frontend just needs to write to Firestore. No API calls required!

**Create a post:**
```javascript
await db.collection('discord_posts').add({
  title: 'My Post',
  description: 'Post content',
  author: 'Username',
  status: 'pending'
});
```

**Update a post:**
```javascript
await db.collection('discord_posts').doc(postId).update({
  additionalInfo: 'Updated information',
  updateRequested: true
});
```

## 🔒 Security

- `.env` file is in `.gitignore`
- Firebase service account file is in `.gitignore`
- Bot token and secrets never committed to git
- Database security rules control frontend access

## 🎉 Features

- ✅ Auto-post to Discord from database changes
- ✅ Real-time reaction monitoring
- ✅ Automatic message updates
- ✅ Database-driven architecture
- ✅ Modular, maintainable code
- ✅ Graceful error handling
- ✅ Comprehensive logging