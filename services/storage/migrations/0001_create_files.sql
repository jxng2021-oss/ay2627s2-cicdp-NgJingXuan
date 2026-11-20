CREATE TYPE file_status AS ENUM ('uploading', 'ready', 'deleting');

CREATE TABLE files (
    id uuid PRIMARY KEY NOT NULL,
    tenant_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    original_name text,
    content_type text NOT NULL,
    plain_size bigint DEFAULT 0 NOT NULL,
    encrypted_size bigint DEFAULT 0 NOT NULL,
    encrypted_file_key bytea NOT NULL,
    format_version smallint NOT NULL,
    chunk_size integer NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    nonce_prefix bytea NOT NULL,
    checksum bytea,
    status file_status DEFAULT 'uploading' NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT files_blob_id_unique UNIQUE (blob_id)
);

CREATE TABLE tenant_usage (
    tenant_id uuid PRIMARY KEY NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL
);

CREATE INDEX files_tenant_status_created ON files USING btree (tenant_id, status, created_at);
