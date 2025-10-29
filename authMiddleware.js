const jwt = require('jsonwebtoken');
// This is the same secret key from your authRoutes.js
const JWT_SECRET = 'my-super-secret-key-12345'; 

module.exports = function(req, res, next) {
    // 1. Get token from the header
    const token = req.header('x-auth-token');

    // 2. Check if no token
    if (!token) {
        return res.status(401).json({ message: 'No token, authorization denied' });
    }

    // 3. Verify token
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // 4. Add user from payload to the request object
        // Now all our protected routes will know who the user is
        req.user = decoded.user; 
        next(); // Move to the next function (the actual route)
    } catch (err) {
        res.status(401).json({ message: 'Token is not valid' });
    }
};