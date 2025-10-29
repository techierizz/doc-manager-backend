// Import the 'dotenv' library to load environment variables
require('dotenv').config();

// Import the 'Pool' class from the 'pg' (PostgreSQL) library
const { Pool } = require('pg');

// Create a new connection pool
// A pool is an efficient way to manage multiple database connections
const pool = new Pool({
    user: 'postgres', // The default PostgreSQL user
    host: 'localhost',
    database: 'doc_manager', // The database we created in pgAdmin
    password: process.env.DB_PASSWORD, // Gets the password from your .env file
    port: 5432, // The default PostgreSQL port
});

// We export this 'query' function so our other files can use it.
// This is a "wrapper" that lets us easily send queries to the database.
module.exports = {
    query: (text, params) => pool.query(text, params),
};