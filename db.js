const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Determine database path
let dbPath;
if (process.env.RENDER) {
    // On Render, use the persistent disk mounted at /data
    dbPath = '/data/data.db';
} else {
    // Local development: store in project root
    dbPath = path.join(__dirname, 'data.db');
}

// Ensure the directory exists (especially for /data)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Open database (creates file if it doesn't exist)
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    subscription_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Insert the single user if not exists
const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get('KG_Kgomotso');
if (!existingUser) {
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('KG_Kgomotso', 'KgomotsoAuto16&');
}

module.exports = db;
