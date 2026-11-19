import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  captureLogs,
  IDENTITY_SERVICE_TOKEN,
  INTERNAL_SERVICE_TOKEN,
  newTenant,
  startSecrets,
  testKeyProvider,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/secrets.openapi.json"));
let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;

beforeEach(async () => {
  logs = captureLogs();
  app = await startSecrets({ logStream: logs.stream });
});

async function call(
  url: string,
  tenantId: string,
  body: object,
  token: string | null = IDENTITY_SERVICE_TOKEN,
  target = app,
): Promise<LightMyRequestResponse> {
  const response = await target.inject({
    method: "POST",
    url,
    headers: {
      "x-tenant-id": tenantId,
      "x-request-id": randomUUID(),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: body,
  });
  expect(
    contract.checkResponse("POST", url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
  return response;
}

const wrap = (tenantId: string, poolId: string, key: Buffer) =>
  call("/internal/signing-keys/wrap", tenantId, {
    poolId,
    key: key.toString("base64"),
  });
const unwrap = (tenantId: string, poolId: string, wrappedKey: string) =>
  call("/internal/signing-keys/unwrap", tenantId, { poolId, wrappedKey });
const wrapped = async (tenant: string, pool: string, key: Buffer) =>
  (await wrap(tenant, pool, key)).json<{ wrappedKey: string }>().wrappedKey;

describe("signing keys", () => {
  it("wraps a data key and unwraps it again for the same tenant and pool", async () => {
    const tenant = newTenant();
    const pool = randomUUID();
    const key = randomBytes(32);

    const response = await wrap(tenant, pool, key);
    const { wrappedKey } = response.json<{ wrappedKey: string }>();
    const unwrapped = await unwrap(tenant, pool, wrappedKey);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(wrappedKey, "base64").includes(key)).toBe(false);
    expect(unwrapped.json()).toEqual({ key: key.toString("base64") });
  });

  it("refuses a wrapped key moved to another pool or tenant, or used as a file key (generic 500)", async () => {
    const tenant = newTenant();
    const other = newTenant();
    const pool = randomUUID();
    await wrap(other, randomUUID(), randomBytes(32));
    const blob = await wrapped(tenant, pool, randomBytes(32));

    const otherPool = await unwrap(tenant, randomUUID(), blob);
    const otherTenant = await unwrap(other, pool, blob);
    const asFileKey = await call(
      "/internal/file-keys/unwrap",
      tenant,
      { fileId: pool, wrappedKey: blob },
      INTERNAL_SERVICE_TOKEN,
    );

    for (const response of [otherPool, otherTenant, asFileKey]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      });
    }
  });

  it("each service's token works only on its own routes", async () => {
    const tenant = newTenant();
    const pool = randomUUID();
    const body = { poolId: pool, key: randomBytes(32).toString("base64") };

    const storageOnSigning = await call(
      "/internal/signing-keys/wrap",
      tenant,
      body,
      INTERNAL_SERVICE_TOKEN,
    );
    const identityOnFiles = await call(
      "/internal/file-keys/wrap",
      tenant,
      { fileId: pool, key: body.key },
      IDENTITY_SERVICE_TOKEN,
    );

    expect([storageOnSigning.statusCode, identityOnFiles.statusCode]).toEqual([
      403, 403,
    ]);
  });

  it.each([
    ["no token", null],
    ["a wrong token", "x".repeat(40)],
    ["an almost-right token", `${IDENTITY_SERVICE_TOKEN.slice(0, -1)}X`],
  ])(
    "refuses %s (403), even before saying whether it's sealed",
    async (_case, token) => {
      const keys = testKeyProvider();
      keys.state = "sealed";
      const sealed = await startSecrets({ keyProvider: keys });
      const body = {
        poolId: randomUUID(),
        key: randomBytes(32).toString("base64"),
      };

      const open = await call(
        "/internal/signing-keys/wrap",
        newTenant(),
        body,
        token,
      );
      const closed = await call(
        "/internal/signing-keys/wrap",
        newTenant(),
        body,
        token,
        sealed,
      );

      expect([open.statusCode, closed.statusCode]).toEqual([403, 403]);
    },
  );

  it("503 SECRETS_SEALED while sealed (with the right token)", async () => {
    const keys = testKeyProvider();
    keys.state = "sealed";
    const sealed = await startSecrets({ keyProvider: keys });

    const response = await call(
      "/internal/signing-keys/wrap",
      newTenant(),
      { poolId: randomUUID(), key: randomBytes(32).toString("base64") },
      IDENTITY_SERVICE_TOKEN,
      sealed,
    );

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SECRETS_SEALED" },
    });
  });

  it.each([
    [
      "a short key",
      { poolId: randomUUID(), key: randomBytes(16).toString("base64") },
    ],
    [
      "a bad pool ID",
      { poolId: "pool", key: randomBytes(32).toString("base64") },
    ],
    [
      "an extra field",
      { poolId: randomUUID(), key: randomBytes(32).toString("base64"), x: 1 },
    ],
  ])("refuses %s (400)", async (_case, body) => {
    expect(
      (await call("/internal/signing-keys/wrap", newTenant(), body)).statusCode,
    ).toBe(400);
  });

  it("never logs data keys or wrapped keys", async () => {
    const key = randomBytes(32);
    const tenant = newTenant();
    const pool = randomUUID();
    const blob = await wrapped(tenant, pool, key);
    await unwrap(tenant, pool, blob);

    expect(logs.text()).toContain("request completed");
    expect(logs.text()).not.toContain(key.toString("base64"));
    expect(logs.text()).not.toContain(blob);
  });
});
