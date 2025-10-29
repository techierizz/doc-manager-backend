const express = require('express');
const cors = require('cors');
const fs = require('fs'); // --- ADD THIS LINE ---
const path = require('path');
const authRoutes = require('./authRoutes'); 
const documentRoutes = require('./documentRoutes');
const adminRoutes = require('./adminRoutes');
const usersRoutes = require('./usersRoutes'); // --- ADD THIS LINE ---

// Create our Express app
const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', usersRoutes); // --- ADD THIS LINE ---

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir);
    console.log("Created 'uploads' directory.");
}

// --- Start the Server ---
const PORT = 5000; 
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);

});
