CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'github');--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"provider" "oauth_provider" NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_identities_user_id_idx" ON "oauth_identities" USING btree ("user_id");