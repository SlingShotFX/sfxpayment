const { Pool } = require('pg');

let pool;

// Use DATABASE_URL from environment (Render sets this automatically)
if (process.env.DATABASE_URL) {
  // Render PostgreSQL
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // required for Render
  });
} else {
  // Local development – you can set DATABASE_URL in your .env file
  console.error('DATABASE_URL not set. Using fallback.');
  // Optional fallback to a local SQLite or similar
  process.exit(1);
}

// Create tables and seed the default user
async function initDb() {
  const client = await pool.connect();
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT
      )
    `);

    // Create bots table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        subscription_status TEXT DEFAULT 'inactive',
        subscription_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert default user if not exists
    const existing = await client.query('SELECT id FROM users WHERE username = $1', ['KG_Kgomotso']);
    if (existing.rows.length === 0) {
      await client.query(
        'INSERT INTO users (username, password) VALUES ($1, $2)',
        ['KG_Kgomotso', 'KgomotsoAuto16&']
      );
    }
  } finally {
    client.release();
  }
}

// Run the initialization (non-blocking)
initDb().catch(console.error);

module.exports = pool;
