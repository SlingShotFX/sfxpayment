const { Pool } = require('pg');

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render
  });
} else {
  console.error('DATABASE_URL environment variable is not set.');
  process.exit(1); // Exit if no database connection
}

// Initialize tables and default user
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT
      )
    `);
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
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization failed:', err);
  } finally {
    client.release();
  }
}

initDb();

module.exports = pool;
