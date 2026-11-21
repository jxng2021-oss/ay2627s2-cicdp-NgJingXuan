import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import type { Database } from "../../services/gateway/src/db/client.js";
import { expectPublicContract } from "./contract-helpers.js";
import { Browser, fakeFlags } from "./dashboard-helpers.js";
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

describe("feature flags in the dashboard", () => {
  it("owners create and change flags; members view and test them only", async () => {
    const owner = new Browser(app);
    const workspace = await owner.signUp("owner@example.com", "Flags");
    const created = await owner.request("POST", owner.ws(workspace, "/flags"), {
      body: { key: "sale-banner", kind: "boolean", offValue: false },
    });
    expect(created.statusCode).toBe(201);
    const turnedOn = await owner.request(
      "PUT",
      owner.ws(workspace, "/flags/sale-banner/environments/production"),
      { body: { enabled: true, rules: [], defaultValue: true } },
    );
    expect(turnedOn.statusCode).toBe(200);

    const member = new Browser(app);
    await member.signUp("member@example.com", "Member's own");
    const me = await member.request("GET", "/dashboard/v1/auth/me");
    await insertMembership(db, {
      userId: me.json<{ user: { id: string } }>().user.id,
      tenantId: workspace,
      role: "member",
    });
    expect(
      (await member.request("GET", member.ws(workspace, "/flags"))).statusCode,
    ).toBe(200);
    const test = await member.request(
      "POST",
      member.ws(workspace, "/flags/evaluate"),
      {
        body: { environment: "production", context: { key: "ada" } },
      },
    );
    expect(test.statusCode).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/flags", { key: "x", kind: "boolean", offValue: false }],
      [
        "PUT",
        "/flags/sale-banner/environments/staging",
        { enabled: true, rules: [], defaultValue: true },
      ],
      ["PATCH", "/flags/sale-banner", { description: "x" }],
      ["DELETE", "/flags/sale-banner", undefined],
    ] as const) {
      expectError(
        await member.request(
          method,
          member.ws(workspace, path),
          body ? { body } : {},
        ),
        403,
        "FORBIDDEN",
      );
    }
    expect(
      (await owner.request("DELETE", owner.ws(workspace, "/flags/sale-banner")))
        .statusCode,
    ).toBe(204);
    expect(flags.problems).toEqual([]);
  });
});
