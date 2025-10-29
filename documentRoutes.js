const express = require('express');
const router = express.Router();
const multer = require('multer'); // For handling file uploads
const path = require('path'); // Node.js utility for handling file paths
const db = require('./db'); // Our database connection
const auth = require('./authMiddleware'); // Our auth protection

// --- Multer Configuration ---
// This tells Multer where to store files and how to name them
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); // Store files in the 'uploads/' directory
    },
    filename: function (req, file, cb) {
        // Create a unique filename: timestamp + original name
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

// Initialize Multer with the storage configuration
const upload = multer({ storage: storage });

// === API ENDPOINT: Document Upload (SRS 4.1) ===
// This route is protected: you must be logged in to upload.
// 'upload.single('file')' means we are expecting one file named 'file'
router.post('/upload', auth, upload.single('file'), async (req, res) => {
    
    // 1. Get data from the request
    const { tags } = req.body; // Metadata from the form
    const { filename, path: storagePath, mimetype, size } = req.file; // File info from Multer
    const uploaderId = req.user.id; // User ID from our 'auth' middleware
    
    // Check if a file was actually uploaded
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    try {
        // --- Database Transaction ---
        // We need to perform multiple database writes.
        // A transaction ensures that if one fails, all of them are rolled back.

        // 2. Create a new entry in the 'documents' table
        // This 'document' is the main "container" for all its versions
        const newDocument = await db.query(
            "INSERT INTO documents (owner_id) VALUES ($1) RETURNING document_id",
            [uploaderId]
        );
        const newDocumentId = newDocument.rows[0].document_id;

        // 3. Create the first entry in the 'document_versions' table
        const newVersion = await db.query(
            `INSERT INTO document_versions 
             (document_id, uploader_id, version_number, file_name, file_type, file_size_bytes, storage_path, tags)
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7) RETURNING version_id`,
            [newDocumentId, uploaderId, filename, mimetype, size, storagePath, tags]
        );
        const newVersionId = newVersion.rows[0].version_id;

        // 4. Update the 'documents' table to point to this new version as the 'current' one
        await db.query(
            "UPDATE documents SET current_version_id = $1 WHERE document_id = $2",
            [newVersionId, newDocumentId]
        );
        
        // 5. Create an audit log entry (SRS 4.6)
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details, target_document_id) VALUES ($1, 'UPLOAD', $2, $3)",
            [uploaderId, `Uploaded new document: ${filename}`, newDocumentId]
        );

        res.status(201).json({ 
            message: 'File uploaded and saved successfully!',
            documentId: newDocumentId,
            versionId: newVersionId,
            fileName: filename
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error during file upload process.");
    }
});

// === API ENDPOINT: Search & Filter (SRS 4.2) ===
router.get('/search', auth, async (req, res) => {
    try {
        const { keyword, uploader, date_from, date_to, type, tags } = req.query;
        const userId = req.user.id;
        const userRole = req.user.role;

        // Base query joins documents, versions, and owners
        // It's designed to only show the *current* version of a document
        let queryParams = [];
        let queryClauses = [];

        // --- Base Query ---
        // Selects all current document versions that the user has access to
        let baseQuery = `
            SELECT 
                v.file_name, 
                v.file_type, 
                v.created_at AS last_modified, 
                v.tags, 
                u_owner.username AS uploader
            FROM 
                document_versions v
            JOIN 
                documents d ON v.document_id = d.document_id
            JOIN 
                users u_owner ON d.owner_id = u_owner.user_id
            LEFT JOIN 
                document_permissions p ON d.document_id = p.document_id
            WHERE 
                d.current_version_id = v.version_id
                AND (
                    d.owner_id = $1 
                    OR (p.user_id = $1 AND p.can_view = TRUE)
                    OR $2 = 'Admin'
                )
        `;
        queryParams.push(userId);
        queryParams.push(userRole);


        // --- Dynamic Filters (SRS 4.2) ---
        
        // 1. Keyword search (file name or tags)
        if (keyword) {
            queryParams.push(`%${keyword}%`); // Add '%' for partial matching
            queryClauses.push(`(v.file_name ILIKE $${queryParams.length} OR v.tags ILIKE $${queryParams.length})`);
        }

        // 2. Uploader search
        if (uploader) {
            queryParams.push(`%${uploader}%`);
            queryClauses.push(`u_owner.username ILIKE $${queryParams.length}`);
        }

        // 3. File Type
        if (type) {
            queryParams.push(type);
            queryClauses.push(`v.file_type ILIKE $${queryParams.length}`);
        }

        // 4. Tags
        if (tags) {
            queryParams.push(`%${tags}%`);
            queryClauses.push(`v.tags ILIKE $${queryParams.length}`);
        }
        
        // 5. Date Range
        if (date_from) {
            queryParams.push(date_from);
            queryClauses.push(`v.created_at >= $${queryParams.length}`);
        }
        if (date_to) {
            queryParams.push(date_to);
            queryClauses.push(`v.created_at <= $${queryParams.length}`);
        }

        // --- Assemble the Final Query ---
        let finalQuery = baseQuery;
        if (queryClauses.length > 0) {
            finalQuery += " AND " + queryClauses.join(" AND ");
        }
        
        finalQuery += " ORDER BY v.created_at DESC"; // Show newest first

        // Execute the search query
        const { rows } = await db.query(finalQuery, queryParams);

        res.json({ results: rows });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error during search.");
    }
});

// === API ENDPOINT: Get My Documents (for Dashboard) ===
router.get('/my-documents', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;

        // This query is similar to the search query.
        // It finds all current versions of documents that the user
        // either owns, has view permissions for, or is an Admin.
        const query = `
            SELECT 
                d.document_id,
                v.file_name, 
                v.file_type, 
                v.created_at AS last_modified, 
                u_owner.username AS uploader
            FROM 
                document_versions v
            JOIN 
                documents d ON v.document_id = d.document_id
            JOIN 
                users u_owner ON d.owner_id = u_owner.user_id
            LEFT JOIN 
                document_permissions p ON d.document_id = p.document_id
            WHERE 
                d.current_version_id = v.version_id
                AND (
                    d.owner_id = $1 
                    OR (p.user_id = $1 AND p.can_view = TRUE)
                    OR $2 = 'Admin'
                )
            ORDER BY v.created_at DESC
            LIMIT 10; -- Show 10 most recent
        `;
        
        const { rows } = await db.query(query, [userId, userRole]);
        res.json({ documents: rows });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: Get Document Versions (SRS 4.4) ===
router.get('/:id/versions', auth, async (req, res) => {
    try {
        const { id } = req.params; // The document_id
        const userId = req.user.id;
        const userRole = req.user.role;

        // TODO: Add a permission check here to ensure the user
        // can actually view this document before showing versions.
        // For now, we'll fetch the versions.

        const query = `
            SELECT 
                v.version_id,
                v.version_number,
                v.file_name,
                v.created_at,
                u.username AS uploader,
                d.current_version_id
            FROM 
                document_versions v
            JOIN 
                users u ON v.uploader_id = u.user_id
            JOIN
                documents d ON v.document_id = d.document_id
            WHERE 
                v.document_id = $1
            ORDER BY 
                v.version_number DESC;
        `;

        const { rows } = await db.query(query, [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Document not found or no versions available.' });
        }

        res.json({ versions: rows });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: Download Document Version (SRS 2.2) ===
router.get('/:id/versions/:version_id/download', auth, async (req, res) => {
    try {
        const { version_id } = req.params;
        const userId = req.user.id;

        // 1. Get the file path and name from the database
        // TODO: We should add a permission check here
        const { rows } = await db.query(
            "SELECT storage_path, file_name FROM document_versions WHERE version_id = $1",
            [version_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "File version not found." });
        }

        const { storage_path, file_name } = rows[0];
        
        // 2. Resolve the absolute path to the file
        // 'storage_path' is relative (e.g., 'uploads/file.pdf'), 
        // 'absolutePath' will be the full C:/.../uploads/file.pdf
        const absolutePath = path.resolve(storage_path);

        // 3. Log the download action (SRS 4.6)
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details) VALUES ($1, 'DOWNLOAD', $2)",
            [userId, `Downloaded file: ${file_name} (Version ID: ${version_id})`]
        );

        // 4. Send the file to the user as an attachment
        res.download(absolutePath, file_name, (err) => {
            if (err) {
                // Handle errors, e.g., file not found on disk
                console.error("File download error:", err);
                res.status(500).json({ message: "Error downloading file." });
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Server error" });
    }
});

// === API ENDPOINT: Upload New Version (SRS 4.4, REQ-7) ===
// 'upload.single('file')' is the multer middleware for file handling
router.post('/:id/upload-version', auth, upload.single('file'), async (req, res) => {
    try {
        const { id: documentId } = req.params; // The document_id to update
        const uploaderId = req.user.id;
        
        // 1. Check if a file was actually uploaded
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }
        
        const { filename, path: storagePath, mimetype, size } = req.file;
        const { uploadComment } = req.body; // Optional comment

        // --- Database Transaction ---
        // 2. Get the current highest version number for this document
        const versionResult = await db.query(
            "SELECT MAX(version_number) as max_version FROM document_versions WHERE document_id = $1",
            [documentId]
        );
        
        const newVersionNumber = versionResult.rows[0].max_version + 1;

        // 3. Create the new entry in 'document_versions'
        const newVersion = await db.query(
            `INSERT INTO document_versions 
             (document_id, uploader_id, version_number, file_name, file_type, file_size_bytes, storage_path, upload_comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING version_id`,
            [documentId, uploaderId, newVersionNumber, filename, mimetype, size, storagePath, uploadComment || '']
        );
        
        const newVersionId = newVersion.rows[0].version_id;

        // 4. Update the main 'documents' table to point to this new version
        await db.query(
            "UPDATE documents SET current_version_id = $1 WHERE document_id = $2",
            [newVersionId, documentId]
        );
        
        // 5. Create an audit log entry (SRS 4.6)
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details, target_document_id) VALUES ($1, 'UPLOAD_VERSION', $2, $3)",
            [uploaderId, `Uploaded v${newVersionNumber} for: ${filename}`, documentId]
        );

        res.status(201).json({ 
            message: `Version ${newVersionNumber} uploaded successfully!`,
            newVersion: newVersion.rows[0]
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error during new version upload.");
    }
});

// === API ENDPOINT: Restore Version (SRS 4.4, REQ-8) ===
router.put('/:id/versions/:version_id/restore', auth, async (req, res) => {
    try {
        const { id: documentId, version_id: versionId } = req.params;
        const uploaderId = req.user.id;

        // 1. Check if the version actually belongs to the document
        const versionCheck = await db.query(
            "SELECT version_number, file_name FROM document_versions WHERE document_id = $1 AND version_id = $2",
            [documentId, versionId]
        );

        if (versionCheck.rows.length === 0) {
            return res.status(404).json({ message: "Version not found or does not belong to this document." });
        }
        
        const { version_number, file_name } = versionCheck.rows[0];

        // 2. Update the main 'documents' table to point to this version
        await db.query(
            "UPDATE documents SET current_version_id = $1 WHERE document_id = $2",
            [versionId, documentId]
        );
        
        // 3. Create an audit log entry
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details, target_document_id) VALUES ($1, 'RESTORE_VERSION', $2, $3)",
            [uploaderId, `Restored v${version_number} (${file_name}) as current`, documentId]
        );

        res.status(200).json({ 
            message: `Version ${version_number} has been restored as the current version.`
        });

    } catch (err)
 {
        console.error(err.message);
        res.status(500).send("Server error during version restore.");
    }
});

// === API ENDPOINT: Get Document Permissions (SRS 4.3) ===
router.get('/:id/permissions', auth, async (req, res) => {
    try {
        const { id: documentId } = req.params;
        const userId = req.user.id;
        
        // TODO: Add a check to ensure only the owner can see permissions
        // For now, we'll fetch them.
        
        const { rows } = await db.query(
            `SELECT p.user_id, u.username, p.can_view, p.can_edit
             FROM document_permissions p
             JOIN users u ON p.user_id = u.user_id
             WHERE p.document_id = $1`,
            [documentId]
        );
        
        res.json({ permissions: rows });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// === API ENDPOINT: Share Document (Set Permissions) (SRS 4.3) ===
router.post('/:id/share', auth, async (req, res) => {
    try {
        const { id: documentId } = req.params;
        const { share_with_user_id, can_view, can_edit } = req.body;
        const ownerId = req.user.id;

        // 1. Check if user is the owner (only owner can share)
        const userRole = req.user.role;
        const doc = await db.query("SELECT owner_id FROM documents WHERE document_id = $1", [documentId]);
        if (doc.rows.length === 0) {
            return res.status(403).json({ message: "Access denied. Only the owner can share." });
        }

        const isOwner = (doc.rows[0].owner_id === ownerId);
        const isAdmin = (userRole === 'Admin');

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: "Access denied. Only the owner or an Admin can manage permissions." });
        }
        
        // 2. Add or update the permission
        // "ON CONFLICT" is a powerful PostgreSQL feature that
        // performs an UPDATE if the row (document_id, user_id) already exists.
        const { rows } = await db.query(
            `INSERT INTO document_permissions (document_id, user_id, can_view, can_edit)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (document_id, user_id)
             DO UPDATE SET can_view = $3, can_edit = $4
             RETURNING *`,
            [documentId, share_with_user_id, can_view, can_edit]
        );
        
        // 3. Log the action
        await db.query(
            "INSERT INTO audit_logs (user_id, action_type, details, target_document_id) VALUES ($1, 'SHARE_DOCUMENT', $2, $3)",
            [ownerId, `Shared document with user ID ${share_with_user_id}`, documentId]
        );

        res.status(201).json({ message: "Permissions updated.", permission: rows[0] });
        
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

module.exports = router;