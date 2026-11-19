import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  captureLogs,
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
  action: "wrap" | "unwrap",
  tenantId: string,
  body: object,
  token: string | null = INTERNAL_SERVICE_TOKEN,
  target = app,
): Promise<LightMyRequestResponse> {
  const url = `/internal/file-keys/${action}`;
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

const wrap = (tenantId: string, fileId: string, key: Buffer) =>
  call("wrap", tenantId, { fileId, key: key.toString("base64") });
const unwrap = (tenantId: string, fileId: string, wrappedKey: string) =>
  call("unwrap", tenantId, { fileId, wrappedKey });

describe("file keys", () => {
  it("wraps a file key and unwraps it again for the same tenant and file", async () => {
    const tenant = newTenant();
    const fileId = randomUUID();
    const key = randomBytes(32);

    const wrapped = await wrap(tenant, fileId, key);
    const { wrappedKey } = wrapped.json<{ wrappedKey: string }>();
    const unwrapped = await unwrap(tenant, fileId, wrappedKey);

    expect(wrapped.statusCode).toBe(200);
    expect(wrapped.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(wrappedKey, "base64").includes(key)).toBe(false);
    expect(unwrapped.json()).toEqual({ key: key.toString("base64") });
  });

  it("wraps the same key differently every time", async () => {
    const tenant = newTenant();
    const fileId = randomUUID();
    const key = randomBytes(32);

    const one = (await wrap(tenant, fileId, key)).json<{
      wrappedKey: string;
    }>();
    const two = (await wrap(tenant, fileId, key)).json<{
      wrappedKey: string;
    }>();

    expect(one.wrappedKey).not.toBe(two.wrappedKey);
  });

  it("refuses a wrapped key copied to another file or another tenant (generic 500)", async () => {
    const tenant = newTenant();
    const other = newTenant();
    const fileId = randomUUID();
    await wrap(other, randomUUID(), randomBytes(32));
    const { wrappedKey } = (await wrap(tenant, fileId, randomBytes(32))).json<{
      wrappedKey: string;
    }>();

    const otherFile = await unwrap(tenant, randomUUID(), wrappedKey);
    const otherTenant = await unwrap(other, fileId, wrappedKey);

    for (const response of [otherFile, otherTenant]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      });
    }
  });

  it("refuses a changed wrapped key", async () => {
    const tenant = newTenant();
    const fileId = randomUUID();
    const { wrappedKey } = (await wrap(tenant, fileId, randomBytes(32))).json<{
      wrappedKey: string;
    }>();
    const changed = Buffer.from(wrappedKey, "base64");
    changed[40] = (changed[40] ?? 0) ^ 1;

    expect(
      (await unwrap(tenant, fileId, changed.toString("base64"))).statusCode,
    ).toBe(500);
  });

  it.each([
    ["no token", null],
    ["a wrong token", "x".repeat(40)],
    ["an almost-right token", `${INTERNAL_SERVICE_TOKEN.slice(0, -1)}X`],
    ["an empty token", ""],
  ])(
    "refuses %s (403), even before saying whether it's sealed",
    async (_case, token) => {
      const sealedKeys = testKeyProvider();
      sealedKeys.state = "sealed";
      const sealed = await startSecrets({ keyProvider: sealedKeys });

      const open = await call(
        "wrap",
        newTenant(),
        { fileId: randomUUID(), key: randomBytes(32).toString("base64") },
        token,
      );
      const closed = await call(
        "wrap",
        newTenant(),
        { fileId: randomUUID(), key: randomBytes(32).toString("base64") },
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
      "wrap",
      newTenant(),
      { fileId: randomUUID(), key: randomBytes(32).toString("base64") },
      INTERNAL_SERVICE_TOKEN,
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
      { fileId: randomUUID(), key: randomBytes(16).toString("base64") },
    ],
    [
      "a bad file ID",
      { fileId: "not-a-uuid", key: randomBytes(32).toString("base64") },
    ],
    [
      "an extra field",
      { fileId: randomUUID(), key: randomBytes(32).toString("base64"), x: 1 },
    ],
  ])("refuses %s (400)", async (_case, body) => {
    expect((await call("wrap", newTenant(), body)).statusCode).toBe(400);
  });

  it("never logs file keys or wrapped keys", async () => {
    const key = randomBytes(32);
    const tenant = newTenant();
    const fileId = randomUUID();
    const { wrappedKey } = (await wrap(tenant, fileId, key)).json<{
      wrappedKey: string;
    }>();
    await unwrap(tenant, fileId, wrappedKey);

    expect(logs.text()).toContain("request completed");
    expect(logs.text()).not.toContain(key.toString("base64"));
    expect(logs.text()).not.toContain(wrappedKey);
  });
});
