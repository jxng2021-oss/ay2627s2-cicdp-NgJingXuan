CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"tenant_id" uuid,
	"service" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"outcome" text NOT NULL,
	"request_id" uuid,
	"source_ip" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_events_chain_seq" UNIQUE("chain","seq")
);
--> statement-breakpoint
CREATE INDEX "audit_events_chain_time" ON "audit_events" USING btree ("chain","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_request" ON "audit_events" USING btree ("request_id");