import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { expectPublicContract } from "./contract-helpers.js";
import { fakeFlags } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  createTenantWithKey,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let flags: Awaited<ReturnType<typeof fakeFlags>>;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  flags = await fakeFlags();
  app = await startGateway({ db, audit: new FakeAudit(), flagsUrl: flags.url });
});

describe("POST /v1/flags/evaluate", () => {
  it("forwards only the validated body, with the tenant from the key", async () => {
    const { tenantId, key } = await createTenantWithKey(app, "flags");

    const response = await app.inject({
      method: "POST",
      url: "/v1/flags/evaluate",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-tenant-id": "00000000-0000-4000-8000-000000000000",
      },
      payload: {
        environment: "production",
        context: { key: "user-1", attributes: { country: "SG" } },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expectPublicContract("POST", "/v1/flags/evaluate", response);
    const sent = flags.requests.at(-1)!;
    expect(sent.headers["x-tenant-id"]).toBe(tenantId);
    expect(sent.headers.authorization).toBeUndefined();
    expect(JSON.parse(sent.body.toString())).toEqual({
      environment: "production",
      context: { key: "user-1", attributes: { country: "SG" } },
    });
    expect(flags.problems).toEqual([]);
  });

  it("refuses bad input before the flags service, and needs a key", async () => {
    const { key } = await createTenantWithKey(app, "flags");
    const post = (payload: object, auth = `Bearer ${key}`) =>
      app.inject({
        method: "POST",
        url: "/v1/flags/evaluate",
        headers: { authorization: auth, "content-type": "application/json" },
        payload,
      });
    expectError(
      await post({ environment: "prod", context: { key: "u" } }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await post({
        environment: "production",
        context: { key: "u", attributes: { "bad name": 1 } },
      }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await post({ environment: "production", context: { key: "u" } }, ""),
      401,
      "UNAUTHORIZED",
    );
    expect(flags.requests).toHaveLength(0);
  });
});
