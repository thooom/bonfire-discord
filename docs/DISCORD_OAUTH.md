# Discord OAuth Authentication

This backend provides Discord OAuth authentication endpoints for your frontend.

## 🔧 Setup

### 1. Environment Variables
Add to your `.env` file:
```bash
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
REDIRECT_URI=https://your-frontend-domain.com/auth/callback
```

### 2. Discord Application Settings
In your Discord Developer Portal:
1. Go to your application → OAuth2 → Redirects
2. Add your redirect URI: `https://your-frontend-domain.com/auth/callback`
3. Save changes

## 🌐 API Endpoints

### `GET /api/auth/discord-url`
Generate Discord OAuth URL for frontend login button.

**Query Parameters:**
- `redirectUri` (optional) - Override default redirect URI

**Response:**
```json
{
  "success": true,
  "authUrl": "https://discord.com/api/oauth2/authorize?...",
  "clientId": "1234567890"
}
```

**Frontend Usage:**
```javascript
// Get Discord OAuth URL
const response = await fetch('/api/auth/discord-url');
const { authUrl } = await response.json();

// Redirect user to Discord
window.location.href = authUrl;
```

### `POST /api/auth/exchange-code`
Exchange Discord authorization code for user data.

**Request Body:**
```json
{
  "code": "discord_authorization_code",
  "redirectUri": "https://your-frontend.com/auth/callback"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "144512224180961281",
    "username": "PlayerName",
    "discriminator": "1234",
    "avatar": "avatar_hash",
    "email": "user@example.com",
    "verified": true
  },
  "message": "Login successful"
}
```

**Frontend Usage:**
```javascript
// After Discord redirects back with code
const urlParams = new URLSearchParams(window.location.search);
const code = urlParams.get('code');

if (code) {
  const response = await fetch('/api/auth/exchange-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      code,
      redirectUri: window.location.origin + '/auth/callback'
    })
  });
  
  const data = await response.json();
  if (data.success) {
    // Store user data and redirect to app
    localStorage.setItem('user', JSON.stringify(data.user));
    window.location.href = '/dashboard';
  }
}
```

### `GET /api/auth/user/:discordId`
Get user data by Discord ID.

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "144512224180961281",
    "username": "PlayerName",
    "discriminator": "1234",
    "avatar": "avatar_hash",
    "verified": true,
    "lastLogin": "2025-10-22T21:00:00.000Z"
  }
}
```

### `POST /api/auth/logout`
Logout user (updates logout timestamp).

**Request Body:**
```json
{
  "discordId": "144512224180961281"
}
```

## 🎯 Complete Frontend Flow

### 1. Login Page
```javascript
// Login button handler
async function handleDiscordLogin() {
  try {
    const response = await fetch('/api/auth/discord-url');
    const { authUrl } = await response.json();
    window.location.href = authUrl;
  } catch (error) {
    console.error('Login failed:', error);
  }
}
```

### 2. Callback Page (`/auth/callback`)
```javascript
// Handle Discord callback
async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const error = urlParams.get('error');

  if (error) {
    console.error('Discord OAuth error:', error);
    window.location.href = '/login?error=' + error;
    return;
  }

  if (code) {
    try {
      const response = await fetch('/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          code,
          redirectUri: window.location.origin + '/auth/callback'
        })
      });

      const data = await response.json();
      
      if (data.success) {
        // Store user data
        localStorage.setItem('user', JSON.stringify(data.user));
        localStorage.setItem('discordId', data.user.id);
        
        // Redirect to main app
        window.location.href = '/dashboard';
      } else {
        throw new Error(data.error);
      }
    } catch (error) {
      console.error('Authentication failed:', error);
      window.location.href = '/login?error=auth_failed';
    }
  }
}

// Run on page load
handleCallback();
```

### 3. User Session Management
```javascript
// Check if user is logged in
function getCurrentUser() {
  const userData = localStorage.getItem('user');
  return userData ? JSON.parse(userData) : null;
}

// Logout
async function logout() {
  const user = getCurrentUser();
  if (user) {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId: user.id })
    });
  }
  
  localStorage.removeItem('user');
  localStorage.removeItem('discordId');
  window.location.href = '/login';
}
```

## 🔒 Security Features

- ✅ User data stored in Firestore `users/{discordId}` collection
- ✅ Only registered users can sign up for roams (existing validation)
- ✅ Sensitive tokens not returned to frontend
- ✅ User data automatically updated on each login
- ✅ Email addresses not exposed in public endpoints

## 🎯 Integration with Roam System

This OAuth system seamlessly integrates with your existing roam signup system:
1. User logs in via Discord OAuth → User created/updated in `users/{discordId}`
2. User reacts to Discord posts → Backend validates against `users/{discordId}`
3. Only registered users can sign up for roams → Existing validation works perfectly

Your Discord OAuth authentication is now ready! 🚀