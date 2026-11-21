import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach } from "vitest";
import { buildApp } from "../../services/flags/src/app.js";
import {
  AuditClient,
  type AuditEvent,
} from "../../services/flags/src/audit.js";
import {
  MIGRATIONS_FOLDER,
  type Database,
} from "../../services/flags/src/db/client.js";
import * as schema from "../../services/flags/src/db/schema.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let shared: { db: Database; client: PGlite } | undefined;
afterAll(async () => {
  await shared?.client.close();
  shared = undefined;
});

export async function createTestDatabase(): Promise<{
  db: Database;
  client: PGlite;
}> {
  if (!shared) {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    shared = { db, client };
  } else {
    await shared.client.exec("truncate table flags");
  }
  return shared;
}

export class FakeAudit {
  events: AuditEvent[] = [];
  down = false;
  readonly client = new AuditClient(
    (event) => {
      if (this.down) return Promise.reject(new Error("audit service is down"));
      this.events.push(event);
      return Promise.resolve();
    },
    [1, 1],
  );
}

export interface TestService {
  app: FastifyInstance;
  db: Database;
  audit: FakeAudit;
}

export async function startFlags(): Promise<TestService> {
  const { db } = await createTestDatabase();
  const audit = new FakeAudit();
  const app = buildApp({ db, audit: audit.client });
  cleanups.push(() => app.close());
  await app.ready();
  return { app, db, audit };
}

export function call(
  app: FastifyInstance,
  tenantId: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      "x-tenant-id": tenantId,
      "x-request-id": randomUUID(),
      "x-actor-id": randomUUID(),
    },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

export const newTenant = () => randomUUID();

export async function createFlag(
  app: FastifyInstance,
  tenantId: string,
  key = "new-checkout",
): Promise<void> {
  const response = await call(app, tenantId, "POST", "/flags", {
    key,
    kind: "boolean",
    offValue: false,
  });
  if (response.statusCode !== 201) throw new Error(response.body);
}
