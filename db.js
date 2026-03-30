const Database = require('better-sqlite3');
const path = require('path');

// Use persistent disk if running on Render
const dbPath = process.env.RENDER ? '/data/data.db' : path.join(__dirname, 'data.db');
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
const user = db.prepare('SELECT id FROM users WHERE username = ?').get('KG_Kgomotso');
if (!user) {
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('KG_Kgomotso', 'KgomotsoAuto16&');
}

module.exports = db;
