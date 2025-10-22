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
Frontend can update the Discord message in two ways:

**Option A - Manual Update Request:**
```javascript
{
  additionalInfo: "New information",
  updateRequested: true  // Triggers Discord message update
}
```

**Option B - Direct Content Update:**
```javascript
{
  title: "Updated Title",
  description: "Updated description",
  additionalInfo: "New information"
  // Discord message updates automatically
}
```

### 4. Backend Auto-Updates Discord
Backend detects changes and:
- **Edits the existing Discord message** (doesn't create new one)
- Updates message content with latest information
- Preserves existing reactions and message ID
- Marks update as completed

### 5. Discord Reactions Sync to Roam Signups
When users react in Discord:
- Backend monitors ✅ reactions
- **Adds Discord user to roam signups** in `gameData/roams` collection
- **Removes user when they unreact**
- Updates reaction counts in Firestore
- Real-time sync between Discord and roam data

## 🎮 **Roam Signup System**

### How Roam Signups Work:
1. **Frontend creates Discord post** with `roamId` field
2. **Backend posts to Discord** with roam information
3. **Users react with ✅** in Discord
4. **Backend automatically adds them** to `gameData/roams → scheduled → [roamId] → signups`
5. **Users unreact** → Backend removes them from signups

### Roam Data Structure:
```javascript
// gameData/roams document structure
{
  scheduled: [
    {
      id: "1761131559339",        // roamId referenced in discord_posts
      category: "statics",        // roam category
      composition: "1761116117621", // composition ID
      createdAt: "2025-10-22T11:12:39.339Z",
      createdBy: "144512224180961281", // Discord ID of creator
      date: "2025-10-02",         // roam date
      time: "22:50",              // roam time
      title: "Evening PvP Roam",  // roam title
      signups: [                  // Array of Discord IDs (auto-managed)
        "144512224180961281",     // Discord user ID
        "987654321098765432"      // Another Discord user ID
      ]
    }
  ]
}
```

### User Validation:
- **Only registered users** can sign up for roams
- Backend checks `users/{discordId}/id` before allowing signup
- Unknown Discord users are ignored

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
  roamId: string,          // ID of the roam from gameData/roams
  roamDetails: object,     // Optional roam details for display
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

**Create a roam signup post:**
```javascript
await db.collection('discord_posts').add({
  title: 'Evening PvP Roam',
  description: 'Join us for some PvP action!',
  author: 'RoamLeader',
  roamId: 'roam123',  // Must match ID in gameData/roams
  roamDetails: {      // Optional: for richer Discord display
    type: 'PvP',
    datetime: '2025-10-22T20:00:00Z',
    leader: 'Guild Leader'
  },
  status: 'pending'
});
```

**Update a Discord message:**
```javascript
// Option 1: Manual update request
await db.collection('discord_posts').doc(postId).update({
  additionalInfo: 'Updated information',
  updateRequested: true  // Explicitly request Discord update
});

// Option 2: Direct content update (future feature)
await db.collection('discord_posts').doc(postId).update({
  title: 'New Title',
  description: 'Updated content',
  additionalInfo: 'Additional details'
  // Discord message will update automatically
});
```

## 🎮 **Roam Management**

**Your frontend manages roams in the `gameData/roams` document:**
```javascript
// The signups array is automatically managed by Discord reactions
// You only need to manage the roam details:
await db.collection('gameData').doc('roams').update({
  scheduled: firebase.firestore.FieldValue.arrayUnion({
    id: '1761131559339',
    category: 'statics',
    composition: '1761116117621',
    createdAt: '2025-10-22T11:12:39.339Z',
    createdBy: '144512224180961281',
    date: '2025-10-02',
    time: '22:50',
    title: 'Evening PvP Roam',
    signups: []  // This will be populated by Discord reactions
  })
});

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