module.exports = {
    adminOnly: (req, res, next) => {
        // Ensure the user exists and their role is Admin
        if (req.user && req.user.role === 'Admin') {
            next(); // Allow them to proceed to the route
        } else {
            res.status(403).json({ 
                message: "Access denied. This action requires Administrator privileges." 
            });
        }
    }
};
