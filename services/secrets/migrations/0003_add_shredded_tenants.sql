CREATE TABLE IF NOT EXISTS shredded_tenants (
    tenant_id uuid PRIMARY KEY NOT NULL,
    shredded_at timestamp with time zone DEFAULT now() NOT NULL
);
