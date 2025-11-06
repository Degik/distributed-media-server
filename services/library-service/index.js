// /services/library-service/index.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib'); // Client RabbitMQ
const path = require('path');

// --- Dependency imports for Consul and gRPC ---
const Consul = require('consul'); // Client Consul
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Load contract .proto
const PROTO_PATH = path.resolve(__dirname, './proto/scanner.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const scannerProto = grpc.loadPackageDefinition(packageDefinition).scanner;
// ScannerService

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://guest:guest@rabbitmq";
const CONSUL_HOST = process.env.CONSUL_HOST || 'consul';
const CONSUL_PORT = process.env.CONSUL_PORT || 8500;

// --- Configurazione Consul ---
// Client Consul to query service registry
const consul = new Consul({
  host: CONSUL_HOST,
  port: CONSUL_PORT,
  promisify: true, // Use promises
});

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const initializeDatabase = async () => {
  try {
    // Create 'libraries' table with agent_tag
    await pool.query(`
      CREATE TABLE IF NOT EXISTS libraries (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        path_on_agent VARCHAR(255) NOT NULL,
        agent_tag VARCHAR(100) NOT NULL, 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Tabella 'libraries' (con agent_tag) verificata/creata.");
  } catch (err) {
    console.error("Errore durante l'inizializzazione del database:", err);
    setTimeout(initializeDatabase, 5000); // Riprova
  }
};

// RabbitMQ Connection and Channel
let rabbitChannel = null;
const METADATA_QUEUE = 'metadata_requests'; // Queue for metadata processing

const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    rabbitChannel = await connection.createChannel();
    //
    await rabbitChannel.assertQueue(METADATA_QUEUE, { durable: true });
    console.log(`Connesso a RabbitMQ e coda '${METADATA_QUEUE}' assicurata.`);
  } catch (err) {
    console.error("Errore durante la connessione a RabbitMQ:", err);
    setTimeout(connectRabbitMQ, 5000); // Riprova
  }
};

// JWT Authentication Middleware
// Protects routes by verifying JWT tokens
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) {
    return res.status(401).json({ message: "Token non fornito" });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Token non valido" });
    }
    req.user = user;
    next();
  });
};

// --- API Endpoints ---

/**
 * 1. Create a Library
 * POST /libraries
 * Specify the Agent (agent_tag) and the path (path_on_agent) it is associated with
 */
app.post('/libraries', authenticateToken, async (req, res) => {
  const { name, path_on_agent, agent_tag } = req.body;

  if (!name || !path_on_agent || !agent_tag) {
    return res.status(400).json({ message: "Nome, path_on_agent e agent_tag sono richiesti" });
  }

  try {
    const newLibrary = await pool.query(
      "INSERT INTO libraries (name, path_on_agent, agent_tag) VALUES ($1, $2, $3) RETURNING *",
      [name, path_on_agent, agent_tag]
    );
    res.status(201).json(newLibrary.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Errore interno del server" });
  }
});

/**
 * 2. Get All Libraries
 * GET /libraries
 */
app.get('/libraries', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM libraries");
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Errore interno del server" });
  }
});

/**
 * 3. Request a Scan (Orchestration)
 * POST /libraries/:id/scan
 */
app.post('/libraries/:id/scan', authenticateToken, async (req, res) => {
  const libraryId = req.params.id;

  try {
    // 1. Find library by ID and get its agent_tag and path_on_agent
    const libResult = await pool.query("SELECT * FROM libraries WHERE id = $1", [libraryId]);
    const library = libResult.rows[0];

    if (!library) {
      return res.status(404).json({ message: "Libreria non trovata" });
    }

    // 2. Find a healthy Agent via Consul using the agent_tag
    console.log(`[INFO] Cerco agente con tag: ${library.agent_tag}`);
    // Ask Consul for healthy services with this tag
    const services = await consul.health.service({
      service: library.agent_tag,
      passing: true, // Only healthy instances
    });

    if (services.length === 0) {
      console.warn(`[WARN] Nessun agente 'sano' trovato con tag: ${library.agent_tag}`);
      return res.status(404).json({ message: `Nessun agente 'sano' trovato per ${library.agent_tag}` });
    }

    // Take the first available agent
    const agentNode = services[0].Service;
    const agentAddress = `${agentNode.Address}:${agentNode.Port}`;
    console.log(`[INFO] Contatto Agente C++ su: ${agentAddress}`);

    // 3. Create the gRPC Client and CALL the Agent
    const grpcClient = new scannerProto.ScannerService(
      agentAddress,
      grpc.credentials.createInsecure()
    );

    const scanRequest = { path_to_scan: library.path_on_agent };

    // Call ScanPath on the agent
    const scanResponse = await new Promise((resolve, reject) => {
      // Set a deadline for the gRPC call
      const deadline = new Date();
      deadline.setMinutes(deadline.getMinutes() + 10);

      grpcClient.ScanPath(scanRequest, { deadline }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // 4. Process the scan results and send messages to RabbitMQ
    const filesFound = scanResponse.files_found || [];
    console.log(`[INFO] Scansione gRPC completata. Trovati ${filesFound.length} file.`);

    if (!rabbitChannel) {
      console.error("[ERRORE] Connessione RabbitMQ non disponibile per inviare i metadati.");
    } else {
      // For each file found, send a message to the metadata queue
      let publishedCount = 0;
      for (const file of filesFound) {
        const message = {
          libraryId: library.id,
          file_path: file.file_path,
          file_size_bytes: file.file_size_bytes,
          last_modified: file.last_modified,
        };
        const messageBuffer = Buffer.from(JSON.stringify(message));

        // Send the message to the queue for future processing (e.g. metadata-service)
        rabbitChannel.sendToQueue(METADATA_QUEUE, messageBuffer, { persistent: true });
        publishedCount++;
      }
      console.log(`[INFO] Sent ${publishedCount} messages to the '${METADATA_QUEUE}' queue.`);
    }

    // 5. Respond to the user
    res.status(200).json({
      message: "Scan completed and messages sent for processing.",
      files_found_count: filesFound.length,
    });

  } catch (err) {
    console.error("[ERROR] Orchestrated scan failed:", err);
    // gRPC error handling
    if (err.code === grpc.status.DEADLINE_EXCEEDED) {
      return res.status(504).json({ message: "Timeout: the scan is taking too long." });
    }
    if (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.NOT_FOUND) {
      return res.status(503).json({ message: "Agent service not reachable or not found." });
    }
    // Generic error
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Brain (Library-Service) listening on port ${PORT}`);
  // Start connections to external services
  initializeDatabase();
  connectRabbitMQ();
});