DO $$
BEGIN
    CREATE TYPE tenant_key_status AS ENUM ('active', 'retired');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS secrets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    latest_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secrets_tenant_name UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS secret_versions (
    secret_id uuid NOT NULL REFERENCES secrets (id) ON DELETE CASCADE,
    version integer NOT NULL,
    tenant_key_version integer NOT NULL,
    format_version smallint NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secret_versions_secret_id_version_pk PRIMARY KEY (secret_id, version)
);

CREATE TABLE IF NOT EXISTS tenant_keys (
    tenant_id uuid NOT NULL,
    key_version integer NOT NULL,
    status tenant_key_status DEFAULT 'active' NOT NULL,
    master_key_version integer NOT NULL,
    format_version smallint NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_keys_tenant_id_key_version_pk PRIMARY KEY (tenant_id, key_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_keys_one_active_per_tenant ON tenant_keys (tenant_id) WHERE status = 'active';
