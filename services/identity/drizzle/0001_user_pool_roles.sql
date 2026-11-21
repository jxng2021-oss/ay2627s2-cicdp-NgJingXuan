CREATE TABLE "pool_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_roles_pool_name" UNIQUE("pool_id","name")
);
--> statement-breakpoint
CREATE TABLE "pool_user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "pool_roles" ADD CONSTRAINT "pool_roles_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_user_roles" ADD CONSTRAINT "pool_user_roles_user_id_pool_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pool_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_user_roles" ADD CONSTRAINT "pool_user_roles_role_id_pool_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."pool_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_user_roles_role_idx" ON "pool_user_roles" USING btree ("role_id");