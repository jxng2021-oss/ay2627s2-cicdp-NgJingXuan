import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import type { Database } from "../../services/gateway/src/db/client.js";
import {
  Browser,
  fakeAuditEvents,
  fakeFlags,
  fakeIdentity,
  fakeSecrets,
  fakeStorage,
} from "./dashboard-helpers.js";
import {
  createTestDatabase,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let audit: FakeAudit;
let secrets: Awaited<ReturnType<typeof fakeSecrets>>;
let storage: Awaited<ReturnType<typeof fakeStorage>>;
let identity: Awaited<ReturnType<typeof fakeIdentity>>;
let flagService: Awaited<ReturnType<typeof fakeFlags>>;
let owner: Browser;
let workspace: string;
const NAME = "Doomed workspace";

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  audit = new FakeAudit();
  secrets = await fakeSecrets();
  storage = await fakeStorage();
  identity = await fakeIdentity();
  flagService = await fakeFlags();
  const auditService = await fakeAuditEvents();
  app = await startGateway({
    db,
    audit,
    secretsUrl: secrets.url,
    storageUrl: storage.url,
    auditUrl: auditService.url,
    identityUrl: identity.url,
    flagsUrl: flagService.url,
  });
  owner = new Browser(app);
  workspace = await owner.signUp("owner@example.com", NAME);
});

const remove = (browser: Browser, confirmName = NAME) =>
  browser.request("DELETE", browser.ws(workspace, ""), {
    body: { confirmName },
  });

async function apiKey(): Promise<string> {
  const created = await owner.request(
    "POST",
    owner.ws(workspace, "/api-keys"),
    { body: { name: "app" } },
  );
  return created.json<{ key: string }>().key;
}

describe("deleting a workspace (crypto-shredding)", () => {
  it("destroys the key, the data and the workspace, after recording it", async () => {
    const key = await apiKey();
    await owner.request("PUT", owner.ws(workspace, "/secrets/db"), {
      body: { value: "v" },
    });
    await owner.request("POST", owner.ws(workspace, "/files"), {
      raw: Buffer.from("hello"),
      headers: { "content-type": "text/plain" },
    });

    const response = await remove(owner);
    expect(response.statusCode).toBe(204);

    expect(
      audit.events.find((e) => e.action === "tenant.shredded"),
    ).toMatchObject({
      tenantId: workspace,
      resourceId: workspace,
      actorType: "user",
      requestId: response.headers["x-request-id"],
    });
    expect(secrets.shredded.has(workspace)).toBe(true);
    expect([...secrets.values.keys()]).toEqual([]);
    expect([...storage.files.values()]).toEqual([]);
    expect(identity.deletedTenants.has(workspace)).toBe(true);
    expect(identity.problems).toEqual([]);
    expect(flagService.deletedTenants.has(workspace)).toBe(true);
    expect(flagService.problems).toEqual([]);

    expectError(
      await owner.request("GET", owner.ws(workspace, "")),
      404,
      "NOT_FOUND",
    );
    const me = await owner.request("GET", "/dashboard/v1/auth/me");
    expect(me.json<{ workspaces: unknown[] }>().workspaces).toEqual([]);
    const withKey = await app.inject({
      method: "GET",
      url: "/v1/storage/files",
      headers: { authorization: `Bearer ${key}` },
    });
    expectError(withKey, 401, "UNAUTHORIZED");
  });

  it("needs the exact name, and an owner", async () => {
    expectError(await remove(owner, "doomed workspace"), 400, "BAD_REQUEST");

    const member = new Browser(app);
    await member.signUp("member@example.com", "Member's own");
    const me = await member.request("GET", "/dashboard/v1/auth/me");
    await insertMembership(db, {
      userId: me.json<{ user: { id: string } }>().user.id,
      tenantId: workspace,
      role: "member",
    });
    expectError(await remove(member), 403, "FORBIDDEN");
    expect(secrets.shredded.size).toBe(0);
    expect(audit.events.some((e) => e.action === "tenant.shredded")).toBe(
      false,
    );
  });

  it("changes nothing while sealed, or if the audit log can't record it", async () => {
    secrets.state.sealed = true;
    expectError(await remove(owner), 503, "SECRETS_SEALED");
    secrets.state.sealed = false;

    audit.down = true;
    expectError(await remove(owner), 503, "SERVICE_UNAVAILABLE");
    audit.down = false;

    expect(
      (await owner.request("GET", owner.ws(workspace, ""))).statusCode,
    ).toBe(200);
    expect(secrets.shredded.size).toBe(0);
  });

  it("a deletion stopped part-way blocks the workspace (409) until it is finished", async () => {
    storage.state.failTenantDelete = true;
    expectError(await remove(owner), 502, "UPSTREAM_UNAVAILABLE");
    expect(secrets.shredded.has(workspace)).toBe(true);
    expectError(
      await owner.request("GET", owner.ws(workspace, "/secrets")),
      409,
      "CONFLICT",
    );
    expectError(
      await owner.request("GET", owner.ws(workspace, "")),
      409,
      "CONFLICT",
    );

    storage.state.failTenantDelete = false;
    expect((await remove(owner)).statusCode).toBe(204);
    expectError(
      await owner.request("GET", owner.ws(workspace, "")),
      404,
      "NOT_FOUND",
    );
    expect(
      audit.events.filter((e) => e.action === "tenant.shredded"),
    ).toHaveLength(1);
  });
});

describe("deleting a workspace with user pools", () => {
  it("stops (502) if the identity service fails, and finishes when sent again", async () => {
    identity.state.failing = true;
    const failed = await remove(owner);
    expect(failed.statusCode).toBe(502);
    expectError(
      await owner.request("GET", owner.ws(workspace, "")),
      409,
      "CONFLICT",
    );

    identity.state.failing = false;
    expect((await remove(owner)).statusCode).toBe(204);
    expect(identity.deletedTenants.has(workspace)).toBe(true);
  });
});
