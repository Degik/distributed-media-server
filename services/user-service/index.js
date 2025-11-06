// /services/user-service/index.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json()); 

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Database connection details from environment variables
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Helper function to initialize the database
const initializeDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Tabella 'users' verificata/creata con successo.");
  } catch (err) {
    console.error("Errore durante l'inizializzazione del database:", err);
    // Wait and retry
    setTimeout(initializeDatabase, 5000);
  }
};

// --- Middleware for JWT Authentication ---
// Used to protect the /me route
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format "Bearer TOKEN"

  if (token == null) {
    return res.status(401).json({ message: "Token non fornito" }); // Unauthorized
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Token non valido" }); // Forbidden
    }
    req.user = user; // Save user data to request object
    next();
  });
};

// --- API Definition (as per Phase 2) ---

/**
 * 1. User Registration
 * POST /register
 */
app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: `Username e password sono richiesti: { username: ${username}, password: ${password} }, IP: ${req.ip}` });
  }

  try {
    // Password hashing
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Insert into database
    const newUser = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, password_hash]
    );

    res.status(201).json(newUser.rows[0]);
  } catch (err) {
    // Error 23505 = unique constraint violation (user already exists)
    if (err.code === '23505') {
      return res.status(409).json({ message: "Username già esistente" }); // Conflict
    }
    console.error(err);
    res.status(500).json({ message: "Errore interno del server" });
  }
});

/**
 * 2. Login Utente
 * POST /login
 */
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. Find user by username
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: "Credenziali non valide" });
    }

    // 2. Verify password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Credenziali non valide" });
    }

    // 3. Create and sign the JWT
    const payload = {
      id: user.id,
      username: user.username,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' }); // Expires in 1 hour

    res.status(200).json({ token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * 3. User Details (Protected Route)
 * GET /me
 */
app.get('/me', authenticateToken, async (req, res) => {
  // User data (id, username) has been added by 'authenticateToken'
  res.status(200).json(req.user);
});

// Start server and initialize DB
app.listen(PORT, () => {
  console.log(`User-Service in ascolto sulla porta ${PORT}`);
  initializeDatabase();
});