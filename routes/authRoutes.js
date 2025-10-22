import express from 'express';
import { collections } from '../services/firebase.js';

const router = express.Router();

/**
 * GET /api/auth/callback
 * Handle Discord OAuth callback and redirect to frontend with user data
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    
    console.log(`🔄 OAuth callback received`);
    console.log(`🔄 Query params:`, req.query);

    if (error) {
      console.error(`❌ Discord OAuth error: ${error}`);
      return res.redirect(`https://bonfire-albion.web.app/auth/error?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      console.error(`❌ No authorization code received`);
      return res.redirect(`https://bonfire-albion.web.app/auth/error?error=no_code`);
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Discord token exchange failed:', errorData);
      return res.redirect(`https://bonfire-albion.web.app/auth/error?error=token_exchange_failed`);
    }

    const tokenData = await tokenResponse.json();

    // Get user information from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      console.error('Failed to fetch Discord user data');
      return res.redirect(`https://bonfire-albion.web.app/auth/error?error=user_fetch_failed`);
    }

    const discordUser = await userResponse.json();

    // Create/update user in Firestore
    const userData = {
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      email: discordUser.email,
      verified: discordUser.verified,
      lastLogin: new Date(),
      updatedAt: new Date()
    };

    // Check if user exists
    const userDoc = await collections.get(collections.USERS).doc(discordUser.id).get();
    
    if (userDoc.exists) {
      // Update existing user
      await collections.get(collections.USERS).doc(discordUser.id).update(userData);
      console.log(`✅ Updated existing user: ${discordUser.username}#${discordUser.discriminator}`);
    } else {
      // Create new user
      userData.createdAt = new Date();
      await collections.get(collections.USERS).doc(discordUser.id).set(userData);
      console.log(`🆕 Created new user: ${discordUser.username}#${discordUser.discriminator}`);
    }

    // Create a simple token for the frontend (just the user data encoded)
    const userToken = Buffer.from(JSON.stringify({
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      verified: discordUser.verified
    })).toString('base64');

    // Redirect to frontend with user data
    const redirectUrl = `https://bonfire-albion.web.app/auth/success?token=${userToken}`;
    console.log(`✅ Redirecting to frontend: ${redirectUrl}`);
    
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('❌ Error in OAuth callback:', error.message);
    console.error('❌ Stack trace:', error.stack);
    res.redirect(`https://bonfire-albion.web.app/auth/error?error=internal_error`);
  }
});

/**
 * POST /api/auth/exchange-code
 * Exchange Discord authorization code for user data and store/update user
 */
router.post('/exchange-code', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code) {
      return res.status(400).json({ 
        error: 'Authorization code is required' 
      });
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri || process.env.REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Discord token exchange failed:', errorData);
      return res.status(400).json({ 
        error: 'Failed to exchange authorization code',
        details: errorData
      });
    }

    const tokenData = await tokenResponse.json();

    // Get user information from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      console.error('Failed to fetch Discord user data');
      return res.status(400).json({ 
        error: 'Failed to fetch user data from Discord' 
      });
    }

    const discordUser = await userResponse.json();

    // Create/update user in Firestore
    const userData = {
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator,
      avatar: discordUser.avatar,
      email: discordUser.email,
      verified: discordUser.verified,
      lastLogin: new Date(),
      updatedAt: new Date()
    };

    // Check if user exists
    const userDoc = await collections.get(collections.USERS).doc(discordUser.id).get();
    
    if (userDoc.exists) {
      // Update existing user
      await collections.get(collections.USERS).doc(discordUser.id).update(userData);
      console.log(`✅ Updated existing user: ${discordUser.username}#${discordUser.discriminator}`);
    } else {
      // Create new user
      userData.createdAt = new Date();
      await collections.get(collections.USERS).doc(discordUser.id).set(userData);
      console.log(`🆕 Created new user: ${discordUser.username}#${discordUser.discriminator}`);
    }

    // Return user data (without sensitive token info)
    res.json({
      success: true,
      user: {
        id: discordUser.id,
        username: discordUser.username,
        discriminator: discordUser.discriminator,
        avatar: discordUser.avatar,
        email: discordUser.email,
        verified: discordUser.verified
      },
      message: 'Login successful'
    });

  } catch (error) {
    console.error('❌ Error in Discord OAuth:', error.message);
    res.status(500).json({
      error: 'Internal server error during authentication',
      details: error.message
    });
  }
});

/**
 * GET /api/auth/login
 * Direct redirect to Discord OAuth (what your frontend expects)
 */
router.get('/login', (req, res) => {
  try {
    const { frontend } = req.query;
    
    console.log(`🔗 Login request received`);
    console.log(`🔗 Query params:`, req.query);
    console.log(`🔗 Frontend param: ${frontend}`);
    
    // Check if required env variables exist
    if (!process.env.DISCORD_CLIENT_ID) {
      console.error('❌ DISCORD_CLIENT_ID not set in environment variables');
      return res.status(500).json({
        error: 'Discord OAuth not configured - missing DISCORD_CLIENT_ID'
      });
    }
    
    // Use backend callback URL - the backend will handle the callback and redirect to frontend
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
    
    console.log(`🔗 Using backend callback URI: ${redirectUri}`);
    console.log(`🔗 Discord Client ID: ${process.env.DISCORD_CLIENT_ID}`);
    
    const baseUrl = 'https://discord.com/api/oauth2/authorize';
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email',
    });

    const authUrl = `${baseUrl}?${params.toString()}`;
    
    console.log(`🚀 Redirecting to Discord OAuth: ${authUrl}`);

    // Redirect directly to Discord OAuth
    res.redirect(authUrl);

  } catch (error) {
    console.error('❌ Error in login redirect:', error.message);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({
      error: 'Failed to redirect to Discord OAuth',
      details: error.message,
      stack: error.stack
    });
  }
});

/**
 * GET /api/auth/discord-url
 * Generate Discord OAuth URL for frontend (alternative method)
 */
router.get('/discord-url', (req, res) => {
  try {
    const { redirectUri } = req.query;
    
    const baseUrl = 'https://discord.com/api/oauth2/authorize';
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri || process.env.REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',
    });

    const authUrl = `${baseUrl}?${params.toString()}`;

    res.json({
      success: true,
      authUrl,
      clientId: process.env.DISCORD_CLIENT_ID
    });

  } catch (error) {
    console.error('❌ Error generating Discord URL:', error.message);
    res.status(500).json({
      error: 'Failed to generate Discord OAuth URL',
      details: error.message
    });
  }
});

/**
 * GET /api/auth/user/:discordId
 * Get user data by Discord ID
 */
router.get('/user/:discordId', async (req, res) => {
  try {
    const { discordId } = req.params;

    const userDoc = await collections.get(collections.USERS).doc(discordId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        error: 'User not found' 
      });
    }

    const userData = userDoc.data();
    
    // Remove sensitive data
    delete userData.email;
    
    res.json({
      success: true,
      user: userData
    });

  } catch (error) {
    console.error('❌ Error fetching user:', error.message);
    res.status(500).json({
      error: 'Failed to fetch user data',
      details: error.message
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (mainly for logging purposes)
 */
router.post('/logout', async (req, res) => {
  try {
    const { discordId } = req.body;

    if (discordId) {
      // Update last logout time
      await collections.get(collections.USERS).doc(discordId).update({
        lastLogout: new Date()
      });
      
      console.log(`👋 User logged out: ${discordId}`);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('❌ Error during logout:', error.message);
    res.status(500).json({
      error: 'Failed to logout',
      details: error.message
    });
  }
});

export default router;