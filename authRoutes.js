const express = require('express');
const bcrypt = require('bcryptjs'); // For password hashing
const jwt = require('jsonwebtoken'); // For creating tokens
const db = require('./db'); // Our database connection

const router = express.Router();

// --- SECRET KEY for JWT ---
// In a real app, this should be a long, random string stored in your .env file
const JWT_SECRET = 'my-super-secret-key-12345';

// === API ENDPOINT: User Registration (SRS 2.3) ===
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ message: "All fields are required." });
        }

        const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: "Please enter a valid email address." });
        }

        if (password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters long." });
        }

        if (username.length < 3 || username.includes(' ')) {
            return res.status(400).json({ message: "Username must be 3-20 characters and contain no spaces." });
        }
        ////////////////

        // 1. Check if user already exists
        const userExists = await db.query(
            "SELECT * FROM users WHERE email = $1 OR username = $2",
            [email, username]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: "Username or email already exists." });
        }

        // 2. Hash the password (SRS 5.3 - Strong password policies)
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // 3. Insert the new user into the database
        // We set the role to 'Viewer' by default. 'Admin' must be set manually.
        const newUser = await db.query(
            "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, 'Viewer') RETURNING user_id, username, role",
            [username, email, passwordHash]
        );

        res.status(201).json({ 
            message: "User registered successfully!",
            user: newUser.rows[0]
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: User Login (SRS 2.2 - User Authentication) ===
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // 1. Find the user in the database
        const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Invalid credentials." });
        }
        
        const user = result.rows[0];

        // 2. Compare the provided password with the stored hash
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        // 3. Create a JSON Web Token (JWT)
        // This token contains the user's ID and role, and is signed
        // with our secret key.
        const payload = {
            user: {
                id: user.user_id,
                role: user.role // from the database (e.g., 'Admin', 'Viewer')
            }
        };

        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

        // 4. Send the token back to the frontend
        res.json({
            message: "Login successful!",
            token: token,
            username: user.username,
            role: user.role
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});


module.exports = router;
