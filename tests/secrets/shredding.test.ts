import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import { INTERNAL_SERVICE_TOKEN, newTenant, startSecrets } from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/secrets.openapi.json"));
let app: FastifyInstance;

beforeEach(async () => {
  app = await startSecrets();
});

async function call(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  tenantId: string,
  body?: object,
  token?: string,
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method,
    url,
    headers: {
      "x-tenant-id": tenantId,
      "x-request-id": randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });
  expect(
    contract.checkResponse(method, url.split("?")[0]!, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
  return response;
}

const fileKeys = (action: "wrap" | "unwrap", tenantId: string, body: object) =>
  call(
    "POST",
    `/internal/file-keys/${action}`,
    tenantId,
    body,
    INTERNAL_SERVICE_TOKEN,
  );

describe("crypto-shredding a tenant", () => {
  it("makes copies of its wrapped file keys useless, for good", async () => {
    const tenant = newTenant();
    const fileId = randomUUID();
    const key = randomBytes(32);
    const { wrappedKey } = (
      await fileKeys("wrap", tenant, { fileId, key: key.toString("base64") })
    ).json<{ wrappedKey: string }>();
    expect(
      (await fileKeys("unwrap", tenant, { fileId, wrappedKey })).statusCode,
    ).toBe(200);

    const shred = await call("DELETE", "/internal/tenant", tenant);
    expect(shred.statusCode).toBe(204);

    const after = await fileKeys("unwrap", tenant, { fileId, wrappedKey });
    expect(after.statusCode).toBe(404);
    expect(after.body).not.toContain(key.toString("base64"));
    const wrapAgain = await fileKeys("wrap", tenant, {
      fileId: randomUUID(),
      key: randomBytes(32).toString("base64"),
    });
    expect(wrapAgain.statusCode).toBe(404);
  });

  it("deletes the tenant's secrets, and only that tenant's", async () => {
    const doomed = newTenant();
    const other = newTenant();
    await call("PUT", "/secrets/db", doomed, { value: "doomed-value" });
    await call("PUT", "/secrets/db", other, { value: "other-value" });

    expect((await call("DELETE", "/internal/tenant", doomed)).statusCode).toBe(
      204,
    );

    expect((await call("GET", "/secrets/db", doomed)).statusCode).toBe(404);
    expect((await call("GET", "/secrets", doomed)).json()).toEqual({
      secrets: [],
      nextCursor: null,
    });
    const kept = await call("GET", "/internal/secrets/db", other);
    expect(kept.json<{ value: string }>().value).toBe("other-value");
  });

  it("is safe to repeat", async () => {
    const tenant = newTenant();
    await call("PUT", "/secrets/db", tenant, { value: "v" });
    expect((await call("DELETE", "/internal/tenant", tenant)).statusCode).toBe(
      204,
    );
    expect((await call("DELETE", "/internal/tenant", tenant)).statusCode).toBe(
      204,
    );
  });
});
