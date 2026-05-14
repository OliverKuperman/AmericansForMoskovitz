-- Read-only role for the DraftDustinChapters server.
-- Grants SELECT on petition_signatures ONLY. Safe to re-run.
--
-- Usage (psql):  psql "$DATABASE_URL" -v role_pw="'some-strong-pw'" -f create_readonly_role.sql
-- Or run setup_readonly_role.js, which fills in :role_pw from READONLY_ROLE_PASSWORD.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chapters_reader') THEN
    EXECUTE format('CREATE ROLE chapters_reader LOGIN PASSWORD %L', :'role_pw');
  ELSE
    EXECUTE format('ALTER ROLE chapters_reader LOGIN PASSWORD %L', :'role_pw');
  END IF;
END
$$;

-- Make sure the role can never accumulate write privileges.
REVOKE ALL ON DATABASE moskovitz_petition FROM chapters_reader;
GRANT  CONNECT ON DATABASE moskovitz_petition TO chapters_reader;

REVOKE ALL ON SCHEMA public FROM chapters_reader;
GRANT  USAGE ON SCHEMA public TO chapters_reader;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM chapters_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM chapters_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM chapters_reader;

-- The one and only grant: read the confirmed signatures.
GRANT SELECT ON petition_signatures TO chapters_reader;

-- Do not let this role read anything created in public in the future.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM chapters_reader;
