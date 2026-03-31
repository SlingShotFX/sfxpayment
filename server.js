const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const db = require('./db'); // PostgreSQL pool

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true if using HTTPS
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  }
}));

// Helper: check authentication
function isAuthenticated(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).send('Unauthorized');
}

// ------------------ LOGIN / LOGOUT ------------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query(
      'SELECT id FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).send('Invalid credentials');
    }
    req.session.userId = result.rows[0].id;
    res.send('OK');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Logout failed');
    }
    res.clearCookie('connect.sid', { path: '/' });
    res.send('OK');
  });
});

// ------------------ PAYPAL HELPER ------------------
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await axios.post(
    `https://api-m.${process.env.PAYPAL_MODE === 'live' ? 'paypal.com' : 'sandbox.paypal.com'}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return response.data.access_token;
}

// ------------------ BOT MANAGEMENT ------------------
// Get all bots for the logged-in user
app.get('/api/bots', isAuthenticated, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM bots WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/bots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add a new bot (free)
app.post('/api/bots', isAuthenticated, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send('Bot name required');
  try {
    const result = await db.query(
      'INSERT INTO bots (user_id, name, subscription_status) VALUES ($1, $2, $3) RETURNING id',
      [req.session.userId, name, 'inactive']
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error('POST /api/bots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a bot (also cancel its subscription if active)
app.delete('/api/bots/:id', isAuthenticated, async (req, res) => {
  const botId = req.params.id;
  try {
    // Get bot subscription info
    const botResult = await db.query(
      'SELECT subscription_id, subscription_status FROM bots WHERE id = $1 AND user_id = $2',
      [botId, req.session.userId]
    );
    if (botResult.rows.length === 0) {
      return res.status(404).send('Bot not found');
    }
    const bot = botResult.rows[0];
    if (bot.subscription_status === 'active' && bot.subscription_id) {
      // Cancel PayPal subscription
      const accessToken = await getPayPalAccessToken();
      await axios.post(
        `https://api-m.${process.env.PAYPAL_MODE === 'live' ? 'paypal.com' : 'sandbox.paypal.com'}/v1/billing/subscriptions/${bot.subscription_id}/cancel`,
        { reason: 'Bot deleted by user' },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    }
    // Delete bot
    await db.query('DELETE FROM bots WHERE id = $1 AND user_id = $2', [botId, req.session.userId]);
    res.sendStatus(200);
  } catch (err) {
    console.error('DELETE /api/bots/:id error:', err);
    res.status(500).send('Error deleting bot');
  }
});

// Activate subscription for a bot
app.post('/api/bots/:id/activate-subscription', isAuthenticated, async (req, res) => {
  const { subscriptionID } = req.body;
  const botId = req.params.id;
  try {
    await db.query(
      'UPDATE bots SET subscription_id = $1, subscription_status = $2 WHERE id = $3 AND user_id = $4',
      [subscriptionID, 'active', botId, req.session.userId]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error('POST /api/bots/:id/activate-subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cancel subscription for a bot
app.post('/api/bots/:id/cancel-subscription', isAuthenticated, async (req, res) => {
  const botId = req.params.id;
  try {
    const botResult = await db.query(
      'SELECT subscription_id FROM bots WHERE id = $1 AND user_id = $2',
      [botId, req.session.userId]
    );
    if (botResult.rows.length === 0 || !botResult.rows[0].subscription_id) {
      return res.status(400).send('No active subscription found');
    }
    const subscriptionId = botResult.rows[0].subscription_id;
    const accessToken = await getPayPalAccessToken();
    await axios.post(
      `https://api-m.${process.env.PAYPAL_MODE === 'live' ? 'paypal.com' : 'sandbox.paypal.com'}/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason: 'Cancelled by user' },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    await db.query(
      'UPDATE bots SET subscription_status = $1, subscription_id = NULL WHERE id = $2 AND user_id = $3',
      ['cancelled', botId, req.session.userId]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error('POST /api/bots/:id/cancel-subscription error:', err);
    res.status(500).send('Error cancelling subscription');
  }
});

// ------------------ ACCOUNTS ENDPOINT ------------------
app.get('/api/accounts', isAuthenticated, (req, res) => {
  const filePath = path.join(__dirname, 'ExoMarkets', '1', 'configs', 'account.txt');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading account.txt:', err);
      return res.status(500).json({ error: 'Could not read accounts file' });
    }
    const accounts = data.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));
    res.json(accounts);
  });
});

// ------------------ SUBSCRIPTION STATUS (for frontend) ------------------
app.get('/api/subscription-status', isAuthenticated, async (req, res) => {
  try {
    // This endpoint returns the subscription status of the user (not per bot).
    // For simplicity, we return the status of the first bot? Or we can check if any bot is active.
    // In your original design, subscription is per bot. But frontend may expect a global status.
    // To avoid confusion, we'll return a global flag based on whether the user has at least one active bot.
    const result = await db.query(
      'SELECT EXISTS(SELECT 1 FROM bots WHERE user_id = $1 AND subscription_status = $2) as has_active',
      [req.session.userId, 'active']
    );
    const hasActive = result.rows[0].has_active;
    res.json({ status: hasActive ? 'active' : 'inactive', subscriptionID: null });
  } catch (err) {
    console.error('GET /api/subscription-status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------ CATCH-ALL FOR SPA ROUTING ------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------ START SERVER ------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
