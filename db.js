const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.RENDER ? '/data/data.db' : path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Users table – single user with provided credentials
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  // Bots table – each bot belongs to a user, has its own subscription
  db.run(`
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT,
      subscription_status TEXT DEFAULT 'inactive',
      subscription_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Insert the single user if not exists
  db.get('SELECT id FROM users WHERE username = ?', ['KG_Kgomotso'], (err, row) => {
    if (!row) {
      db.run(
        'INSERT INTO users (username, password) VALUES (?, ?)',
        ['KG_Kgomotso', 'KgomotsoAuto16&']
      );
    }
  });
});

module.exports = db;