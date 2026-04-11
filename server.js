'use strict';
require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app = express();

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        styleSrc:    ["'self'", 'https://fonts.googleapis.com'],
        fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
        imgSrc:      ["'self'", 'data:'],
        scriptSrc:   ["'self'"],
        connectSrc:  ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ─── Rate Limiting (petition endpoint) ───────────────────────────────────────
const petitionLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many submission attempts. Please try again in 15 minutes.' },
});

// ─── PostgreSQL Connection Pool ───────────────────────────────────────────────
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT, 10) || 5432,
        database: process.env.DB_NAME     || 'moskovitz_petition',
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      }
);

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.use('/images', express.static('Images'));

// ─── Database Initialisation ──────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS petition_signatures (
        id        SERIAL       PRIMARY KEY,
        name      VARCHAR(100) NOT NULL,
        email     VARCHAR(255) NOT NULL,
        signed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT petition_signatures_email_unique UNIQUE (email)
      );
    `);
    console.log('[DB] Table ready.');
  } finally {
    client.release();
  }
}

// ─── Input Validation ─────────────────────────────────────────────────────────
const NAME_RE  = /^[A-Za-z\s'\-\.]{2,100}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validatePetition(name, email) {
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    return 'Please enter a valid full name (2–100 characters, letters, spaces, hyphens, and apostrophes only).';
  }
  if (typeof email !== 'string' || email.length > 255 || !EMAIL_RE.test(email.trim())) {
    return 'Please enter a valid email address.';
  }
  return null;
}

// ─── API: Submit Petition ─────────────────────────────────────────────────────
app.post('/api/petition', petitionLimiter, async (req, res) => {
  const { name, email } = req.body ?? {};

  const validationError = validatePetition(name, email);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    await pool.query(
      'INSERT INTO petition_signatures (name, email) VALUES ($1, $2)',
      [name.trim(), email.trim().toLowerCase()]
    );

    const { rows } = await pool.query(
      'SELECT COUNT(*) AS count FROM petition_signatures'
    );

    return res.json({ success: true, count: parseInt(rows[0].count, 10) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This email address has already signed the petition.' });
    }
    console.error('[DB] Insert error:', err.message);
    return res.status(500).json({ error: 'A server error occurred. Please try again.' });
  }
});

// ─── API: Get Signature Count ─────────────────────────────────────────────────
app.get('/api/petition/count', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS count FROM petition_signatures'
    );
    return res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    console.error('[DB] Count error:', err.message);
    return res.status(500).json({ error: 'Could not retrieve count.' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Americans for Moskovitz  →  http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('[FATAL] Could not initialise database:', err.message);
    process.exit(1);
  });
