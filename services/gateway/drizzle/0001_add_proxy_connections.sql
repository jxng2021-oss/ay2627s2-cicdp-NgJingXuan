CREATE TABLE "proxy_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"secret_name" text NOT NULL,
	"header_name" text NOT NULL,
	"header_prefix" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_connections_tenant_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "proxy_connections" ADD CONSTRAINT "proxy_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;