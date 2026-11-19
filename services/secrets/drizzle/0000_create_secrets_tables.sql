CREATE TYPE "public"."tenant_key_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TABLE "secret_versions" (
	"secret_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"tenant_key_version" integer NOT NULL,
	"format_version" smallint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_versions_secret_id_version_pk" PRIMARY KEY("secret_id","version")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_tenant_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "tenant_keys" (
	"tenant_id" uuid NOT NULL,
	"key_version" integer NOT NULL,
	"status" "tenant_key_status" DEFAULT 'active' NOT NULL,
	"master_key_version" integer NOT NULL,
	"format_version" smallint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_keys_tenant_id_key_version_pk" PRIMARY KEY("tenant_id","key_version")
);
--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_keys_one_active_per_tenant" ON "tenant_keys" USING btree ("tenant_id") WHERE status = 'active';