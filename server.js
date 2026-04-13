'use strict';
require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const geoip      = require('geoip-lite');

const app = express();

// Trust the first proxy hop so req.ip reflects the real client IP
// (required on Heroku, Render, Railway, Nginx, etc.)
app.set('trust proxy', 1);

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

app.use('/images', express.static(path.join(__dirname, 'Images')));

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

// ─── US-Only Geolocation Guard ────────────────────────────────────────────────
async function requireUSIP(req, res, next) {
  try {
    const ip = req.ip || req.socket.remoteAddress || '';

    // Normalise IPv4-mapped IPv6 addresses (::ffff:1.2.3.4 → 1.2.3.4)
    const normalised = ip.replace(/^::ffff:/, '');

    // Allow loopback/private addresses in development
    const isLocal =
      normalised === '::1' ||
      normalised === '127.0.0.1' ||
      normalised.startsWith('10.') ||
      normalised.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalised);

    if (isLocal) return next();

    const geo = geoip.lookup(normalised);

    if (geo) {
      if (geo.country !== 'US') {
        return res.status(403).json({ error: 'This petition is open to US residents only.' });
      }
      return next();
    }

    // geoip-lite has no entry for this IP — fall back to ip-api.com
    try {
      const response = await fetch(
        `http://ip-api.com/json/${normalised}?fields=countryCode`,
        { signal: AbortSignal.timeout(3000) }
      );
      const data = await response.json();
      if (data.countryCode === 'US') return next();
    } catch {
      // ip-api.com unreachable — fail closed
    }

    return res.status(403).json({ error: 'This petition is open to US residents only.' });
  } catch (err) {
    next(err);
  }
}

// ─── API: Submit Petition ─────────────────────────────────────────────────────
app.post('/api/petition', petitionLimiter, requireUSIP, async (req, res) => {
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

// ─── Sitemap ──────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (_req, res) => {
  const base = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');

  const pages = [
    { loc: '/',                  priority: '1.0', changefreq: 'weekly'  },
    { loc: '/petition.html',     priority: '0.9', changefreq: 'weekly'  },
    { loc: '/about.html',        priority: '0.7', changefreq: 'monthly' },
    { loc: '/history.html',      priority: '0.6', changefreq: 'monthly' },
    { loc: '/attributions.html', priority: '0.3', changefreq: 'yearly'  },
  ];

  const urls = pages
    .map(
      p => `  <url>\n    <loc>${base}${p.loc}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

  res.header('Content-Type', 'application/xml');
  res.send(xml);
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
