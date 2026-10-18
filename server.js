'use strict';
require('dotenv').config();

const express      = require('express');
const { Pool }     = require('pg');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const crypto       = require('crypto');
const { Resend }   = require('resend');

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

// Provider webhooks are signature-verified against the exact bytes we received,
// so they must be parsed as a raw Buffer before the JSON parser rewrites them.
app.use('/api/webhooks/email', express.raw({ type: '*/*', limit: '100kb' }));

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
        confirmed BOOLEAN      NOT NULL DEFAULT FALSE,
        CONSTRAINT petition_signatures_email_unique UNIQUE (email)
      );
    `);

    // Signatures predating the delivery-based flow were all click-confirmed, so
    // backfill them as TRUE, then default new rows to FALSE.
    await client.query(`
      ALTER TABLE petition_signatures
        ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT TRUE;
    `);
    await client.query(`
      ALTER TABLE petition_signatures
        ALTER COLUMN confirmed SET DEFAULT FALSE;
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

    // Set when a provider tells us the mail actually landed. The row is kept
    // afterwards so a later click can still upgrade the signature to confirmed.
    await client.query(`
      ALTER TABLE pending_verifications
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
    `);

    console.log('[DB] Tables ready.');
  } finally {
    client.release();
  }
}

// ─── Email (Resend primary, MailerSend fallback) ──────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendViaResend(payload) {
  if (!resend) throw new Error('Resend not configured');
  const { error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || 'Resend send failed');
}

// Parse a "Name <email@host>" string into { email, name }; bare addresses also work.
function parseFromAddress(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (match) return { email: match[2].trim(), name: match[1].trim() || undefined };
  return { email: from.trim() };
}

async function sendViaMailerSend(payload) {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) throw new Error('MailerSend not configured');

  const res = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    parseFromAddress(payload.from),
      to:      [{ email: payload.to }],
      subject: payload.subject,
      text:    payload.text,
      html:    payload.html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MailerSend send failed (${res.status}): ${detail}`);
  }
}

const EMAIL_PROVIDERS = [
  { name: 'Resend',     send: sendViaResend     },
  { name: 'MailerSend', send: sendViaMailerSend },
];

async function sendVerificationEmail(name, email, token) {
  const base      = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyUrl = `${base}/verify?token=${token}`;
  const fromAddr  = process.env.RESEND_EMAIL_ADDRESS || 'Americans for Moskovitz <noreply@americansformoskovitz.com>';

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
              Your signature has been counted. Clicking the link above marks it as confirmed, which carries more weight when the petition is delivered. The link works for <strong>30 days</strong>. If you did not sign this petition, reply to this email and we will remove your address.
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

  const text = `Hi ${name},\n\nThank you for signing the Americans for Moskovitz petition. Your signature has been counted.\n\nTo mark it as confirmed, which carries more weight when the petition is delivered, visit this link (works for 30 days):\n${verifyUrl}\n\nIf you did not sign this petition, reply to this email and we will remove your address.\n\n— Americans for Moskovitz`;

  const payload = {
    from:    fromAddr,
    to:      email,
    subject: 'Confirm your petition signature — Americans for Moskovitz',
    html,
    text,
  };

  const errors = [];
  for (const provider of EMAIL_PROVIDERS) {
    try {
      await provider.send(payload);
      if (errors.length) {
        console.warn(`[Email] Sent via ${provider.name} after ${errors.length} failure(s): ${errors.map(e => e.message).join(' | ')}`);
      }
      return;
    } catch (err) {
      console.error(`[Email] ${provider.name} failed: ${err.message}`);
      errors.push(err);
    }
  }
  throw new Error(`All email providers failed: ${errors.map(e => e.message).join(' | ')}`);
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
    return res.status(400).json({ error: 'You must confirm that you are an American citizen and at least 18 years old to sign this petition.' });
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
    // Look up the pending verification (must be < 30 days old)
    const { rows } = await client.query(`
      SELECT id, name, email
      FROM   pending_verifications
      WHERE  token      = $1
        AND  created_at > NOW() - INTERVAL '30 days'
    `, [token]);

    if (!rows.length) {
      return res.redirect('/petition.html?verify_error=expired');
    }

    const pending = rows[0];

    await client.query('BEGIN');
    try {
      // The signature may already exist from the delivery webhook; either way
      // the click is what marks it confirmed.
      await client.query(`
        INSERT INTO petition_signatures (name, email, confirmed)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (email) DO UPDATE
          SET confirmed = TRUE,
              name      = EXCLUDED.name
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

// ─── Email Provider Webhooks ──────────────────────────────────────────────────
// Delivery is what turns a pending row into a counted signature; a hard bounce or
// spam complaint takes it back out. Clicking the link in the mail is a separate,
// stronger tier tracked by petition_signatures.confirmed.

const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Resend signs with Svix: base64 HMAC-SHA256 over "<id>.<timestamp>.<raw body>".
function verifyResendSignature(req) {
  const secret    = process.env.RESEND_WEBHOOK_SECRET;
  const id        = req.get('svix-id');
  const timestamp = req.get('svix-timestamp');
  const header    = req.get('svix-signature');
  if (!secret || !id || !timestamp || !header) return false;

  const sentAt = parseInt(timestamp, 10) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > WEBHOOK_TOLERANCE_MS) return false;

  const key      = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${req.body.toString('utf8')}`)
    .digest('base64');

  return header.split(' ').some(part => {
    const [version, value] = part.split(',');
    return version === 'v1' && value && safeEqual(value, expected);
  });
}

// MailerSend signs with a hex HMAC-SHA256 over the raw body.
function verifyMailerSendSignature(req) {
  const secret = process.env.MAILERSEND_WEBHOOK_SECRET;
  const sig    = req.get('signature');
  if (!secret || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  return safeEqual(sig, expected);
}

// Mail landed: count the signature, unconfirmed until they click the link.
async function promoteDelivered(email) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id, name FROM pending_verifications WHERE email = $1',
      [email]
    );
    // No pending row means this address was already confirmed, already removed,
    // or belongs to some other mail we sent. Nothing to do either way.
    if (!rows.length) return;

    await client.query('BEGIN');
    try {
      const inserted = await client.query(`
        INSERT INTO petition_signatures (name, email, confirmed)
        VALUES ($1, $2, FALSE)
        ON CONFLICT (email) DO NOTHING
      `, [rows[0].name, email]);

      await client.query(
        'UPDATE pending_verifications SET delivered_at = NOW() WHERE id = $1',
        [rows[0].id]
      );

      await client.query('COMMIT');
      if (inserted.rowCount) {
        invalidateCountCache();
        console.log(`[Webhook] Counted delivered signature for ${email}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

// Hard bounce or spam complaint: drop the pending row and any signature that was
// only ever backed by delivery. Click-confirmed signatures are left alone.
async function dropUndeliverable(email, reason) {
  await pool.query('DELETE FROM pending_verifications WHERE email = $1', [email]);
  const removed = await pool.query(
    'DELETE FROM petition_signatures WHERE email = $1 AND confirmed = FALSE',
    [email]
  );
  if (removed.rowCount) invalidateCountCache();
  console.log(`[Webhook] ${reason} for ${email}; removed ${removed.rowCount} unconfirmed signature(s)`);
}

app.post('/api/webhooks/email/resend', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifyResendSignature(req)) {
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  const recipients = []
    .concat(event?.data?.to ?? [])
    .map(r => String(typeof r === 'string' ? r : r?.email ?? '').trim().toLowerCase())
    .filter(Boolean);

  try {
    for (const email of recipients) {
      if (event.type === 'email.delivered') {
        await promoteDelivered(email);
      } else if (event.type === 'email.bounced' && event?.data?.bounce?.type !== 'Transient') {
        await dropUndeliverable(email, 'Hard bounce');
      } else if (event.type === 'email.complained') {
        await dropUndeliverable(email, 'Spam complaint');
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    // Non-2xx makes the provider retry, which is what we want on a DB blip.
    console.error('[Webhook] Resend handler error:', err.message);
    return res.sendStatus(500);
  }
});

app.post('/api/webhooks/email/mailersend', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifyMailerSendSignature(req)) {
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  const recipient = event?.data?.email?.recipient?.email ?? event?.data?.recipient?.email ?? '';
  const email = String(recipient).trim().toLowerCase();
  if (!email) return res.sendStatus(200);

  try {
    if (event.type === 'activity.delivered') {
      await promoteDelivered(email);
    } else if (event.type === 'activity.hard_bounced') {
      await dropUndeliverable(email, 'Hard bounce');
    } else if (event.type === 'activity.spam_complaint') {
      await dropUndeliverable(email, 'Spam complaint');
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] MailerSend handler error:', err.message);
    return res.sendStatus(500);
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
      WHERE created_at < NOW() - INTERVAL '30 days'
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

    // Clean up stale pending rows every hour
    setInterval(cleanupExpiredPending, 60 * 60 * 1000);
    cleanupExpiredPending();
  })
  .catch(err => {
    console.error('[FATAL] Could not initialise database:', err.message);
    process.exit(1);
  });
