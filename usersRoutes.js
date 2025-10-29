const express = require('express');
const router = express.Router();
const db = require('./db'); // Our database connection
const auth = require('./authMiddleware'); // Our auth protection

// Apply auth middleware to all routes in this file
router.use(auth);

// === API ENDPOINT: Search for users ===
// Allows a logged-in user to find other users by name
router.get('/search', async (req, res) => {
    try {
        const { username } = req.query;
        const currentUserId = req.user.id;

        if (!username || username.length < 2) {
            return res.status(400).json({ message: "Search term must be at least 2 characters." });
        }

        // Find users whose username matches the search term
        // Exclude the user who is doing the searching
        const { rows } = await db.query(
            "SELECT user_id, username FROM users WHERE username ILIKE $1 AND user_id != $2 LIMIT 5",
            [`%${username}%`, currentUserId]
        );
        
        res.json({ users: rows });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

module.exports = router;