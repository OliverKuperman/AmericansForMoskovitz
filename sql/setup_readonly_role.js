'use strict';
// One-shot: creates/updates the read-only `chapters_reader` role on the AFM DB.
// Run from the project root:  node sql/setup_readonly_role.js
//
// Connects as the DB_USER in .env (must have CREATEROLE or be superuser).
// The new role's password comes from READONLY_ROLE_PASSWORD in .env.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const pw = process.env.READONLY_ROLE_PASSWORD;
if (!pw) {
  console.error('Set READONLY_ROLE_PASSWORD in .env before running this script.');
  process.exit(1);
}

// Creating a role needs CREATEROLE/superuser. DB_USER usually isn't one, so
// allow PG_ADMIN_USER / PG_ADMIN_PASSWORD to override just for this script.
const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'moskovitz_petition',
  user: process.env.PG_ADMIN_USER || process.env.DB_USER,
  password: process.env.PG_ADMIN_PASSWORD || process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const dbName = process.env.DB_NAME || 'moskovitz_petition';

// CREATE/ALTER ROLE can't use bind params for the password, so escape it
// as a SQL string literal ourselves ('' for embedded quotes).
const pwLiteral = "'" + String(pw).replace(/'/g, "''") + "'";

const statements = [
  { text: `REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM chapters_reader` },
  { text: `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO chapters_reader` },
  { text: `REVOKE ALL ON SCHEMA public FROM chapters_reader` },
  { text: `GRANT USAGE ON SCHEMA public TO chapters_reader` },
  { text: `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM chapters_reader` },
  { text: `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM chapters_reader` },
  { text: `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM chapters_reader` },
  { text: `GRANT SELECT ON petition_signatures TO chapters_reader` },
  { text: `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM chapters_reader` },
];

function quoteIdent(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

(async () => {
  await client.connect();
  try {
    const { rows: existing } = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'chapters_reader'`
    );
    await client.query(
      existing.length
        ? `ALTER ROLE chapters_reader LOGIN PASSWORD ${pwLiteral}`
        : `CREATE ROLE chapters_reader LOGIN PASSWORD ${pwLiteral}`
    );
    for (const s of statements) {
      await client.query(s.text);
    }
    const { rows } = await client.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'petition_signatures' AND grantee = 'chapters_reader'`
    );
    console.log('Done. chapters_reader privileges on petition_signatures:', rows);
    console.log('\nConnection string for the chapters server (AFM_DATABASE_URL):');
    console.log(`postgres://chapters_reader:${encodeURIComponent(pw)}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${dbName}`);
  } finally {
    await client.end();
  }
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
