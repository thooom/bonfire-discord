import express from 'express';
import { createDiscordPost, requestPostUpdate } from '../services/firestoreListeners.js';
import { collections } from '../services/firebase.js';

const router = express.Router();

/**
 * POST /api/discord/post
 * Create a new Discord post
 */
router.post('/post', async (req, res) => {
  try {
    const { title, description, author, additionalInfo } = req.body;
    
    // Validate required fields
    if (!title) {
      return res.status(400).json({ 
        error: 'Title is required' 
      });
    }

    // Create post data
    const postData = {
      title,
      description: description || '',
      author: author || 'Anonymous',
      additionalInfo: additionalInfo || '',
      timestamp: new Date().toISOString()
    };

    // Create the post in Firestore (this will trigger the Discord post)
    const postId = await createDiscordPost(postData);

    res.status(201).json({
      success: true,
      message: 'Discord post created successfully',
      postId,
      data: postData
    });

  } catch (error) {
    console.error('❌ Error creating Discord post:', error.message);
    res.status(500).json({
      error: 'Failed to create Discord post',
      details: error.message
    });
  }
});

/**
 * PUT /api/discord/post/:postId
 * Update an existing Discord post
 */
router.put('/post/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const { additionalInfo, title, description } = req.body;

    // Validate postId
    if (!postId) {
      return res.status(400).json({ 
        error: 'Post ID is required' 
      });
    }

    // Check if post exists
    const postDoc = await collections.get(collections.DISCORD_POSTS).doc(postId).get();
    if (!postDoc.exists) {
      return res.status(404).json({ 
        error: 'Post not found' 
      });
    }

    // Prepare update data
    const updateData = {};
    if (additionalInfo !== undefined) updateData.additionalInfo = additionalInfo;
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;

    // Request the post update (this will trigger the Discord message update)
    await requestPostUpdate(postId, updateData);

    res.json({
      success: true,
      message: 'Discord post update requested',
      postId,
      updateData
    });

  } catch (error) {
    console.error('❌ Error updating Discord post:', error.message);
    res.status(500).json({
      error: 'Failed to update Discord post',
      details: error.message
    });
  }
});

/**
 * GET /api/discord/posts
 * Get all Discord posts
 */
router.get('/posts', async (req, res) => {
  try {
    const { limit = 20, status } = req.query;
    
    let query = collections.get(collections.DISCORD_POSTS);
    
    // Filter by status if provided
    if (status) {
      query = query.where('status', '==', status);
    }
    
    // Order by creation date (newest first) and limit results
    query = query.orderBy('createdAt', 'desc').limit(parseInt(limit));
    
    const snapshot = await query.get();
    
    const posts = [];
    snapshot.forEach(doc => {
      posts.push({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
        postedAt: doc.data().postedAt?.toDate?.()?.toISOString() || doc.data().postedAt,
        lastUpdated: doc.data().lastUpdated?.toDate?.()?.toISOString() || doc.data().lastUpdated
      });
    });

    res.json({
      success: true,
      posts,
      count: posts.length
    });

  } catch (error) {
    console.error('❌ Error fetching Discord posts:', error.message);
    res.status(500).json({
      error: 'Failed to fetch Discord posts',
      details: error.message
    });
  }
});

/**
 * GET /api/discord/post/:postId
 * Get a specific Discord post
 */
router.get('/post/:postId', async (req, res) => {
  try {
    const { postId } = req.params;

    const postDoc = await collections.get(collections.DISCORD_POSTS).doc(postId).get();
    
    if (!postDoc.exists) {
      return res.status(404).json({ 
        error: 'Post not found' 
      });
    }

    const postData = postDoc.data();
    
    res.json({
      success: true,
      post: {
        id: postDoc.id,
        ...postData,
        createdAt: postData.createdAt?.toDate?.()?.toISOString() || postData.createdAt,
        postedAt: postData.postedAt?.toDate?.()?.toISOString() || postData.postedAt,
        lastUpdated: postData.lastUpdated?.toDate?.()?.toISOString() || postData.lastUpdated
      }
    });

  } catch (error) {
    console.error('❌ Error fetching Discord post:', error.message);
    res.status(500).json({
      error: 'Failed to fetch Discord post',
      details: error.message
    });
  }
});

/**
 * DELETE /api/discord/post/:postId
 * Delete a Discord post (marks as deleted, doesn't remove Discord message)
 */
router.delete('/post/:postId', async (req, res) => {
  try {
    const { postId } = req.params;

    const postDoc = await collections.get(collections.DISCORD_POSTS).doc(postId).get();
    
    if (!postDoc.exists) {
      return res.status(404).json({ 
        error: 'Post not found' 
      });
    }

    // Mark as deleted instead of actually deleting
    await collections.get(collections.DISCORD_POSTS).doc(postId).update({
      status: 'deleted',
      deletedAt: new Date()
    });

    res.json({
      success: true,
      message: 'Discord post marked as deleted',
      postId
    });

  } catch (error) {
    console.error('❌ Error deleting Discord post:', error.message);
    res.status(500).json({
      error: 'Failed to delete Discord post',
      details: error.message
    });
  }
});

export default router;