// /services/library-service/index.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib'); // Client RabbitMQ

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const RABBITMQ_URL = process.env.RABBITMQ_URL;

// Database connection details from environment variables
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const initializeDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS libraries (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        path VARCHAR(255) NOT NULL,
        type VARCHAR(20) NOT NULL, -- 'movies' o 'shows'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Tabella 'libraries' (globale) verificata/creata con successo.");
  } catch (err) {
    console.error("Errore durante l'inizializzazione del database:", err);
    setTimeout(initializeDatabase, 5000);
  }
};

// --- RabbitMQ Configuration ---
let rabbitChannel = null;
const QUEUE_NAME = 'scan_requests';  // Name of our queue

const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();
    await rabbitChannel.assertQueue(QUEUE_NAME, { durable: true });
    console.log(`Connesso a RabbitMQ e coda '${QUEUE_NAME}' assicurata.`);
  } catch (err) {
    console.error("Errore durante la connessione a RabbitMQ:", err);
    setTimeout(connectRabbitMQ, 5000);
  }
};

// --- Middleware for JWT Authentication ---
// This is still needed to ensure the user is logged in
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) {
    return res.status(401).json({ message: "Token not provided" });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Invalid token" });
    }
    req.user = user; // Keep the user, might be useful for logging
    next();
  });
};

// --- API Definition (Global Logic) ---

/**
 * 1. Create a Global Library
 * POST /libraries
 */
app.post('/libraries', authenticateToken, async (req, res) => {
  const { name, path, type } = req.body;

  if (!name || !path || !type) {
    return res.status(400).json({ message: "Nome, path e tipo sono richiesti" });
  }

  try {
    const newLibrary = await pool.query(
      "INSERT INTO libraries (name, path, type) VALUES ($1, $2, $3) RETURNING *",
      [name, path, type]
    );
    res.status(201).json(newLibrary.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Errore interno del server" });
  }
});

/**
 * 2. Get All Global Libraries
 * GET /libraries
 */
app.get('/libraries', authenticateToken, async (req, res) => {
  try {
    // Simplified query, gets everything
    const result = await pool.query("SELECT * FROM libraries");
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/**
 * 3. Request a Scan (Global)
 * POST /libraries/:id/scan
 */
app.post('/libraries/:id/scan', authenticateToken, async (req, res) => {
  const libraryId = req.params.id;

  if (!rabbitChannel) {
    return res.status(500).json({ message: "Servizio di scansione non disponibile" });
  }

  try {
    // 1. Verify library exists
    const result = await pool.query(
      "SELECT * FROM libraries WHERE id = $1",
      [libraryId]
    );
    const library = result.rows[0];

    if (!library) {
      return res.status(404).json({ message: "Libreria non trovata" });
    }

    // 2. Prepare the message
    const message = {
      libraryId: library.id,
      path: library.path,
      type: library.type,
      triggeredBy: req.user.username // Useful for logging!
    };
    const messageBuffer = Buffer.from(JSON.stringify(message));

    // 3. Send the message to the queue
    rabbitChannel.sendToQueue(QUEUE_NAME, messageBuffer, { persistent: true });

    console.log(`[SCAN REQUEST] Sent message for library ${libraryId} from ${req.user.username}`);

    res.status(202).json({ message: "Scan request accepted" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Errore interno del server" });
  }
});

// Start the server and connections
app.listen(PORT, () => {
  console.log(`Library-Service listening on port ${PORT}`);
  initializeDatabase();
  connectRabbitMQ();
});