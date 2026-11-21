CREATE TABLE IF NOT EXISTS seal_config (
    id smallint PRIMARY KEY DEFAULT 1 NOT NULL,
    seal_id uuid NOT NULL,
    share_count smallint NOT NULL,
    threshold smallint NOT NULL,
    master_key_version integer NOT NULL,
    format_version smallint NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    auth_tag bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT seal_config_single_row CHECK (id = 1)
);
