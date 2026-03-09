const express = require('express');
const router = express.Router();
const db = require('./db'); // Our database connection
const auth = require('./authMiddleware'); // Our auth protection
const { adminOnly } = require('../middleware/adminMiddleware');


// Apply auth and admin-only middleware to all routes in this file
router.use(auth);
router.use(adminOnly);

// === API ENDPOINT: Get All Users (SRS 4.3) ===
router.get('/users', async (req, res) => {
    try {
        const { rows } = await db.query("SELECT user_id, username, email, role, created_at FROM users ORDER BY user_id ASC");
        res.json({ users: rows });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: Update User Role (SRS 4.3) ===
router.put('/users/:id/role', async (req, res) => {
    try {
        const { id } = req.params; // The user_id to update
        const { role } = req.body; // The new role ('Admin', 'Editor', 'Viewer')

        // Validate the role
        if (!['Admin', 'Editor', 'Viewer'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role specified.' });
        }

        // Prevent admin from demoting themselves by accident (optional but good practice)
        if (Number(id) === req.user.id && role !== 'Admin') {
            return res.status(400).json({ message: "Admin cannot demote themselves." });
        }

        const update = await db.query(
            "UPDATE users SET role = $1 WHERE user_id = $2 RETURNING user_id, username, role",
            [role, id]
        );

        if (update.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }
        
        // Log this action (SRS 4.6)
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details) VALUES ($1, 'ADMIN_UPDATE_ROLE', $2)",
            [req.user.id, `Set user ${update.rows[0].username} (ID: ${id}) to role: ${role}`]
        );

        res.json({ message: 'User role updated successfully.', user: update.rows[0] });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: Delete User (SRS 4.3) ===
router.delete('/users/:id', async (req, res) => {
    try {
        const { id } = req.params; // The user_id to delete

        // Prevent admin from deleting themselves
        if (Number(id) === req.user.id) {
            return res.status(400).json({ message: "Cannot delete your own admin account." });
        }

        const deleteOp = await db.query("DELETE FROM users WHERE user_id = $1 RETURNING username", [id]);

        if (deleteOp.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }
        
        // Log this action (SRS 4.6)
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details) VALUES ($1, 'ADMIN_DELETE_USER', $2)",
            [req.user.id, `Deleted user ${deleteOp.rows[0].username} (ID: ${id})`]
        );

        res.json({ message: 'User deleted successfully.' });

    } catch (err) {
        console.error(err.message);
        // Handle constraint violation (e.g., if user still owns documents)
        if (err.code === '23503') { // Foreign key violation
            return res.status(400).json({ message: 'Cannot delete user. They still own documents. Please reassign documents first.'});
        }
        res.status(500).send("Server error");
    }
});

router.get('/audit-logs', async (req, res) => {
    try {
        const query = `
            SELECT 
                l.log_id, 
                u.username, 
                l.action_type, 
                l.details, 
                l.timestamp,
                d.document_id,
                v.file_name as target_file
            FROM audit_logs l
            LEFT JOIN users u ON l.user_id = u.user_id
            LEFT JOIN documents d ON l.target_document_id = d.document_id
            LEFT JOIN document_versions v ON d.current_version_id = v.version_id
            ORDER BY l.timestamp DESC 
            LIMIT 100
        `;
        const { rows } = await db.query(query);
        res.json({ logs: rows });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error fetching logs");
    }
});

router.get('/pending-approvals', async (req, res) => {
    try {
        const query = `
            SELECT 
                d.document_id, 
                v.file_name, 
                u.username AS owner, 
                d.status, 
                d.created_at
            FROM documents d
            JOIN document_versions v ON d.current_version_id = v.version_id
            JOIN users u ON d.owner_id = u.user_id
            WHERE d.status = 'Pending Approval'
            ORDER BY d.created_at ASC
        `;
        const { rows } = await db.query(query);
        res.json({ pending: rows });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});


module.exports = router;

