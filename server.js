const express = require('express');
const session = require('express-session');
const db = require('./db');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    path: '/'   // essential for cross‑path cookie sharing
  }
}));

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).send('Unauthorized');
}

// ------------------ LOGIN ------------------


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
    if (err) return res.status(500).send('Logout failed');
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
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
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
    res.status(500).json({ error: err.message });
  }
});

// Add a new bot (free)
app.post('/api/bots', isAuthenticated, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send('Bot name required');
  db.run(
    'INSERT INTO bots (user_id, name, subscription_status) VALUES (?, ?, ?)',
    [req.session.userId, name, 'inactive'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.get('/api/accounts', isAuthenticated, (req, res) => {
    const filePath = path.join(__dirname, '1', 'configs', 'account.txt');
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

// Delete a bot (also cancel its subscription if active)
app.delete('/api/bots/:id', isAuthenticated, async (req, res) => {
  const botId = req.params.id;
  try {
    // First, check if bot has an active subscription
    const bot = await new Promise((resolve, reject) => {
      db.get('SELECT subscription_id, subscription_status FROM bots WHERE id = ? AND user_id = ?', [botId, req.session.userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (bot && bot.subscription_status === 'active' && bot.subscription_id) {
      // Cancel the PayPal subscription
      const accessToken = await getPayPalAccessToken();
      await axios.post(
        `https://api-m.${process.env.PAYPAL_MODE === 'live' ? 'paypal.com' : 'sandbox.paypal.com'}/v1/billing/subscriptions/${bot.subscription_id}/cancel`,
        { reason: 'Bot deleted by user' },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    }
    // Delete bot from database
    db.run('DELETE FROM bots WHERE id = ? AND user_id = ?', [botId, req.session.userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.sendStatus(200);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting bot');
  }
});

// Create a PayPal subscription for a specific bot
app.post('/api/bots/:id/create-subscription', isAuthenticated, (req, res) => {
  // This endpoint returns the PayPal subscription creation details.
  // We'll use the frontend SDK to create the subscription, but we need to pass the bot id.
  // The frontend will call this to get the bot ID, but actually we can just let the frontend
  // create the subscription and then call /api/bots/:id/activate-subscription.
  // So we'll just return a success message; the actual subscription creation happens on the frontend.
  res.json({ botId: req.params.id });
});

// Activate subscription for a bot (store subscription ID)
app.post('/api/bots/:id/activate-subscription', isAuthenticated, (req, res) => {
  const { subscriptionID } = req.body;
  const botId = req.params.id;
  db.run(
    'UPDATE bots SET subscription_id = ?, subscription_status = ? WHERE id = ? AND user_id = ?',
    [subscriptionID, 'active', botId, req.session.userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.sendStatus(200);
    }
  );
});

// Cancel subscription for a bot (call PayPal and update DB)
app.post('/api/bots/:id/cancel-subscription', isAuthenticated, async (req, res) => {
  const botId = req.params.id;
  try {
    const bot = await new Promise((resolve, reject) => {
      db.get('SELECT subscription_id FROM bots WHERE id = ? AND user_id = ?', [botId, req.session.userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!bot || !bot.subscription_id) {
      return res.status(400).send('No active subscription found');
    }
    const accessToken = await getPayPalAccessToken();
    await axios.post(
      `https://api-m.${process.env.PAYPAL_MODE === 'live' ? 'paypal.com' : 'sandbox.paypal.com'}/v1/billing/subscriptions/${bot.subscription_id}/cancel`,
      { reason: 'Cancelled by user' },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    db.run('UPDATE bots SET subscription_status = ?, subscription_id = NULL WHERE id = ? AND user_id = ?', ['cancelled', botId, req.session.userId]);
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error cancelling subscription');
  }
});

const port = process.env.PORT || 3000;

// All API routes (GET/POST /api/...) come before this
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
