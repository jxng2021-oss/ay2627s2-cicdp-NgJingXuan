
\set ON_ERROR_STOP on
\getenv gateway_password GATEWAY_DB_PASSWORD
\getenv secrets_password SECRETS_DB_PASSWORD
\getenv storage_password STORAGE_DB_PASSWORD
\getenv audit_migrator_password AUDIT_MIGRATOR_DB_PASSWORD
\getenv audit_password AUDIT_DB_PASSWORD
\getenv identity_password IDENTITY_DB_PASSWORD
\getenv flags_password FLAGS_DB_PASSWORD

\if :{?gateway_password}
\else
  \set gateway_password ''
\endif
\if :{?secrets_password}
\else
  \set secrets_password ''
\endif
\if :{?storage_password}
\else
  \set storage_password ''
\endif
\if :{?audit_migrator_password}
\else
  \set audit_migrator_password ''
\endif
\if :{?audit_password}
\else
  \set audit_password ''
\endif
\if :{?identity_password}
\else
  \set identity_password ''
\endif
\if :{?flags_password}
\else
  \set flags_password ''
\endif
SELECT :'gateway_password' = '' AS gateway_missing,
       :'secrets_password' = '' AS secrets_missing,
       :'storage_password' = '' AS storage_missing,
       :'audit_migrator_password' = '' AS audit_migrator_missing,
       :'audit_password' = '' AS audit_missing,
       :'identity_password' = '' AS identity_missing,
       :'flags_password' = '' AS flags_missing \gset
\if :gateway_missing
  DO $$ BEGIN RAISE EXCEPTION 'GATEWAY_DB_PASSWORD must be set'; END $$;
\endif
\if :secrets_missing
  DO $$ BEGIN RAISE EXCEPTION 'SECRETS_DB_PASSWORD must be set'; END $$;
\endif
\if :storage_missing
  DO $$ BEGIN RAISE EXCEPTION 'STORAGE_DB_PASSWORD must be set'; END $$;
\endif
\if :audit_migrator_missing
  DO $$ BEGIN RAISE EXCEPTION 'AUDIT_MIGRATOR_DB_PASSWORD must be set'; END $$;
\endif
\if :audit_missing
  DO $$ BEGIN RAISE EXCEPTION 'AUDIT_DB_PASSWORD must be set'; END $$;
\endif
\if :identity_missing
  DO $$ BEGIN RAISE EXCEPTION 'IDENTITY_DB_PASSWORD must be set'; END $$;
\endif
\if :flags_missing
  DO $$ BEGIN RAISE EXCEPTION 'FLAGS_DB_PASSWORD must be set'; END $$;
\endif


SELECT 'CREATE ROLE gateway_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway_app') \gexec
ALTER ROLE gateway_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'gateway_password';

SELECT 'CREATE ROLE secrets_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'secrets_app') \gexec
ALTER ROLE secrets_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'secrets_password';

SELECT 'CREATE ROLE storage_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'storage_app') \gexec
ALTER ROLE storage_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'storage_password';

SELECT 'CREATE ROLE audit_migrator'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_migrator') \gexec
ALTER ROLE audit_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'audit_migrator_password';

SELECT 'CREATE ROLE audit_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_app') \gexec
ALTER ROLE audit_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'audit_password';

SELECT 'CREATE ROLE identity_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') \gexec
ALTER ROLE identity_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'identity_password';

SELECT 'CREATE ROLE flags_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flags_app') \gexec
ALTER ROLE flags_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'flags_password';


SELECT 'CREATE DATABASE secrets OWNER secrets_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'secrets') \gexec
ALTER DATABASE secrets OWNER TO secrets_app;


SELECT 'CREATE DATABASE storage OWNER storage_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'storage') \gexec
ALTER DATABASE storage OWNER TO storage_app;


SELECT 'CREATE DATABASE audit OWNER audit_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'audit') \gexec
ALTER DATABASE audit OWNER TO audit_migrator;


SELECT 'CREATE DATABASE identity OWNER identity_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'identity') \gexec
ALTER DATABASE identity OWNER TO identity_app;


SELECT 'CREATE DATABASE flags OWNER flags_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'flags') \gexec
ALTER DATABASE flags OWNER TO flags_app;


REVOKE ALL ON DATABASE secrets FROM PUBLIC;
REVOKE ALL ON DATABASE storage FROM PUBLIC;
REVOKE ALL ON DATABASE audit FROM PUBLIC;
REVOKE ALL ON DATABASE identity FROM PUBLIC;
REVOKE ALL ON DATABASE flags FROM PUBLIC;
GRANT CONNECT ON DATABASE audit TO audit_app;
REVOKE ALL ON DATABASE platform FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO gateway_app;


REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO gateway_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gateway_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gateway_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gateway_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gateway_app;


\connect audit
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO audit_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO audit_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM audit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO audit_app;

\echo 'Database logins and permissions are up to date'
