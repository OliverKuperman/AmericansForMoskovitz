'use strict';
require('dotenv').config();

// Force IPv4 for all DNS lookups — IPv6 is unreachable on this host
require('dns').setDefaultResultOrder('ipv4first');

const express      = require('express');
const { Pool }     = require('pg');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');

const app = express();

// Trust the first proxy hop so req.ip reflects the real client IP
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

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const petitionLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many submission attempts. Please try again in 15 minutes.' },
});

// ─── Signature Count Cache ────────────────────────────────────────────────────
const countCache = { value: null, expiresAt: 0 };
const COUNT_CACHE_TTL_MS = 60_000;

async function getCachedCount() {
  if (countCache.value !== null && Date.now() < countCache.expiresAt) {
    return countCache.value;
  }
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM petition_signatures');
  countCache.value     = parseInt(rows[0].count, 10);
  countCache.expiresAt = Date.now() + COUNT_CACHE_TTL_MS;
  return countCache.value;
}

function invalidateCountCache() {
  countCache.value = null;
}

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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Prevent browsers from caching JS/CSS so changes are always picked up
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));
app.use('/images', express.static(path.join(__dirname, 'Images')));

// ─── Database Initialisation ──────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    // Confirmed signatures
    await client.query(`
      CREATE TABLE IF NOT EXISTS petition_signatures (
        id        SERIAL       PRIMARY KEY,
        name      VARCHAR(100) NOT NULL,
        email     VARCHAR(255) NOT NULL,
        signed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT petition_signatures_email_unique UNIQUE (email)
      );
    `);

    // Pending email verifications (not yet confirmed)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_verifications (
        id         SERIAL       PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        email      VARCHAR(255) NOT NULL,
        token      CHAR(64)     NOT NULL,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT pending_verifications_email_unique UNIQUE (email),
        CONSTRAINT pending_verifications_token_unique UNIQUE (token)
      );
    `);

    console.log('[DB] Tables ready.');
  } finally {
    client.release();
  }
}

// ─── Email Transport ──────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10_000, // 10 s to establish TCP connection
  greetingTimeout:   8_000,  // 8 s to receive SMTP greeting
  socketTimeout:     15_000, // 15 s of inactivity before giving up
  family:            4,      // Force IPv4 — IPv6 is unreachable on this host
});

async function sendVerificationEmail(name, email, token) {
  const base       = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyUrl  = `${base}/verify?token=${token}`;
  const fromAddr   = process.env.EMAIL_FROM || `"Americans for Moskovitz" <${process.env.SMTP_USER}>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1a3a6b;padding:28px 40px;text-align:center;">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;">
              ★ Americans for Moskovitz
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 28px;color:#1a202c;">
            <h2 style="margin:0 0 18px;font-size:22px;font-weight:700;color:#1a3a6b;">
              Confirm Your Petition Signature
            </h2>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">
              Hi ${name},
            </p>
            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#374151;">
              Thank you for signing our petition urging Dustin Moskovitz to enter the 2028 Democratic Presidential Primary. To confirm your signature, please click the button below:
            </p>

            <!-- CTA Button -->
            <table cellpadding="0" cellspacing="0" style="margin:28px auto;">
              <tr>
                <td style="background:#1a56db;border-radius:6px;text-align:center;">
                  <a href="${verifyUrl}"
                     style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:6px;letter-spacing:0.3px;">
                    Confirm My Signature ✓
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
              This link expires in <strong>24 hours</strong>. If you did not sign this petition, you can safely ignore this email — no action will be taken.
            </p>
            <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#9ca3af;word-break:break-all;">
              If the button above doesn't work, copy and paste this link into your browser:<br>
              <span style="color:#1a56db;">${verifyUrl}</span>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">
              Americans for Moskovitz is a grassroots volunteer movement with no direct connection to Dustin Moskovitz or any official campaign.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Hi ${name},\n\nThank you for signing the Americans for Moskovitz petition.\n\nPlease confirm your signature by visiting this link (expires in 24 hours):\n${verifyUrl}\n\nIf you did not sign this petition, you can ignore this email.\n\n— Americans for Moskovitz`;

  await transporter.sendMail({
    from:    fromAddr,
    to:      email,
    subject: 'Please confirm your petition signature — Americans for Moskovitz',
    html,
    text,
  });
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

// ─── API: Submit Petition (stores pending; does NOT write to petition_signatures) ──
app.post('/api/petition', petitionLimiter, async (req, res) => {
  const { name, email, usCitizen } = req.body ?? {};

  if (!usCitizen) {
    return res.status(400).json({ error: 'You must confirm that you are a US citizen to sign this petition.' });
  }

  const validationError = validatePetition(name, email);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const cleanName  = name.trim();
  const cleanEmail = email.trim().toLowerCase();

  try {
    // Reject if already a confirmed signer
    const existing = await pool.query(
      'SELECT id FROM petition_signatures WHERE email = $1',
      [cleanEmail]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'This email address has already signed the petition.' });
    }

    // Generate a cryptographically secure 64-char hex token
    const token = crypto.randomBytes(32).toString('hex');

    // Upsert into pending_verifications — if they re-submit, refresh the token & timestamp
    await pool.query(`
      INSERT INTO pending_verifications (name, email, token)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE
        SET name       = EXCLUDED.name,
            token      = EXCLUDED.token,
            created_at = NOW()
    `, [cleanName, cleanEmail, token]);

    // Send verification email
    try {
      await sendVerificationEmail(cleanName, cleanEmail, token);
    } catch (emailErr) {
      console.error('[Email] Failed to send verification email:', emailErr.message);
      return res.status(500).json({ error: 'We could not send a verification email. Please try again in a few minutes.' });
    }

    return res.json({ pending: true });
  } catch (err) {
    console.error('[Petition] Error:', err.message);
    return res.status(500).json({ error: 'A server error occurred. Please try again.' });
  }
});

// ─── Email Verification Endpoint ──────────────────────────────────────────────
app.get('/verify', async (req, res) => {
  const { token } = req.query;

  // Basic token shape check
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    return res.redirect('/petition.html?verify_error=invalid');
  }

  const client = await pool.connect();
  try {
    // Look up the pending verification (must be < 24 hours old)
    const { rows } = await client.query(`
      SELECT id, name, email
      FROM   pending_verifications
      WHERE  token      = $1
        AND  created_at > NOW() - INTERVAL '24 hours'
    `, [token]);

    if (!rows.length) {
      return res.redirect('/petition.html?verify_error=expired');
    }

    const pending = rows[0];

    await client.query('BEGIN');
    try {
      // Promote to confirmed signatures (ON CONFLICT in case of a race)
      await client.query(`
        INSERT INTO petition_signatures (name, email)
        VALUES ($1, $2)
        ON CONFLICT (email) DO NOTHING
      `, [pending.name, pending.email]);

      // Remove from pending
      await client.query(
        'DELETE FROM pending_verifications WHERE id = $1',
        [pending.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    invalidateCountCache();
    return res.redirect('/petition.html?verified=1');
  } catch (err) {
    console.error('[Verify] Error:', err.message);
    return res.redirect('/petition.html?verify_error=server');
  } finally {
    client.release();
  }
});

// ─── API: Get Signature Count ─────────────────────────────────────────────────
app.get('/api/petition/count', async (_req, res) => {
  try {
    const count = await getCachedCount();
    return res.json({ count });
  } catch (err) {
    console.error('[DB] Count error:', err.message);
    return res.status(500).json({ error: 'Could not retrieve count.' });
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
    .map(p => `  <url>\n    <loc>${base}${p.loc}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`)
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// ─── Cleanup Expired Pending Verifications ────────────────────────────────────
async function cleanupExpiredPending() {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM pending_verifications
      WHERE created_at < NOW() - INTERVAL '24 hours'
    `);
    if (rowCount > 0) console.log(`[DB] Cleaned up ${rowCount} expired pending verification(s).`);
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Americans for Moskovitz  →  http://localhost:${PORT}\n`);
    });

    // Verify SMTP credentials at startup
    transporter.verify().then(() => {
      console.log('[Email] SMTP connection verified.');
    }).catch(err => {
      console.error('[Email] SMTP configuration error:', err.message);
    });

    // Clean up stale pending rows every hour
    setInterval(cleanupExpiredPending, 60 * 60 * 1000);
    cleanupExpiredPending();
  })
  .catch(err => {
    console.error('[FATAL] Could not initialise database:', err.message);
    process.exit(1);
  });
