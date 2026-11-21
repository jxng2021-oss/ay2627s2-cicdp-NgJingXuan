import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { expectPublicContract } from "./contract-helpers.js";
import {
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startGateway,
} from "./helpers.js";

let app: FastifyInstance;
let auth: { authorization: string };

const VALID = {
  baseUrl: "https://api.example.com/v1",
  secretName: "payments-key",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
};

beforeEach(async () => {
  const { db } = await createTestDatabase();
  app = await startGateway({
    db,
    proxy: { allowedHosts: ["api.example.com"], allowPrivateTargets: false },
  });
  auth = { authorization: `Bearer ${(await createTenantWithKey(app)).key}` };
});

async function call(
  method: "GET" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = auth,
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  expectPublicContract(method, url, response);
  return response;
}

describe("proxy connections", () => {
  it("creates (201), replaces (200), lists and deletes (204) connections", async () => {
    const created = await call("PUT", "/v1/proxy-connections/payments", VALID);
    const replaced = await call("PUT", "/v1/proxy-connections/payments", {
      ...VALID,
      headerName: "X-Api-Key",
      headerPrefix: undefined,
    });
    await call("PUT", "/v1/proxy-connections/billing", VALID);
    const list = await call("GET", "/v1/proxy-connections");
    const deleted = await call("DELETE", "/v1/proxy-connections/billing");
    const again = await call("DELETE", "/v1/proxy-connections/billing");

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "payments", ...VALID });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      headerName: "X-Api-Key",
      headerPrefix: "",
    });
    expect(
      list
        .json<{ connections: { name: string }[] }>()
        .connections.map((c) => c.name),
    ).toEqual(["billing", "payments"]);
    expect(deleted.statusCode).toBe(204);
    expectError(again, 404, "NOT_FOUND");
  });

  it("stores and returns only the secret's name, never a value", async () => {
    const response = await call("PUT", "/v1/proxy-connections/payments", VALID);

    expect(Object.keys(response.json<object>()).sort()).toEqual([
      "baseUrl",
      "createdAt",
      "headerName",
      "headerPrefix",
      "name",
      "policy",
      "secretName",
      "updatedAt",
    ]);
  });

  it("keeps tenants apart", async () => {
    await call("PUT", "/v1/proxy-connections/payments", VALID);
    const other = {
      authorization: `Bearer ${(await createTenantWithKey(app, "Other")).key}`,
    };

    const list = await call("GET", "/v1/proxy-connections", undefined, other);
    const remove = await call(
      "DELETE",
      "/v1/proxy-connections/payments",
      undefined,
      other,
    );

    expect(list.json()).toEqual({ connections: [] });
    expectError(remove, 404, "NOT_FOUND");
    expect(
      (await call("GET", "/v1/proxy-connections")).json<{
        connections: unknown[];
      }>().connections,
    ).toHaveLength(1);
  });

  it("needs an API key", async () => {
    expectError(
      await call("GET", "/v1/proxy-connections", undefined, {}),
      401,
      "UNAUTHORIZED",
    );
  });

  it.each([
    ["a bad name", "/v1/proxy-connections/-bad", VALID],
    [
      "a missing secretName",
      "/v1/proxy-connections/p",
      { ...VALID, secretName: undefined },
    ],
    [
      "an extra field",
      "/v1/proxy-connections/p",
      { ...VALID, secretValue: "x" },
    ],
    [
      "a number as baseUrl",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: 42 },
    ],
    [
      "an http:// URL",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "http://api.example.com" },
    ],
    [
      "a URL with a password",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://u:p@api.example.com" },
    ],
    [
      "a host not on the allowlist",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://evil.example" },
    ],
    [
      "a private address",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://10.0.0.1" },
    ],
    [
      "the metadata address",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://169.254.169.254" },
    ],
    [
      "the secrets service",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://secrets:3002" },
    ],
    [
      "a URL with a query",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: "https://api.example.com/?a=1" },
    ],
    [
      "a very long URL",
      "/v1/proxy-connections/p",
      { ...VALID, baseUrl: `https://api.example.com/${"a".repeat(2100)}` },
    ],
    [
      "a bad secret name",
      "/v1/proxy-connections/p",
      { ...VALID, secretName: "../x" },
    ],
    [
      "a header name with a space",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "X Api" },
    ],
    [
      "a header name with a colon",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "X:Y" },
    ],
    [
      "the Host header",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "Host" },
    ],
    [
      "the Cookie header",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "cookie" },
    ],
    [
      "Content-Length",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "Content-Length" },
    ],
    [
      "X-Tenant-Id",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "X-Tenant-Id" },
    ],
    [
      "a Proxy- header",
      "/v1/proxy-connections/p",
      { ...VALID, headerName: "Proxy-Authorization" },
    ],
    [
      "a prefix with a line break",
      "/v1/proxy-connections/p",
      { ...VALID, headerPrefix: "Bearer\r\nX-Evil: 1 " },
    ],
    [
      "a very long prefix",
      "/v1/proxy-connections/p",
      { ...VALID, headerPrefix: "x".repeat(40) },
    ],
  ])("refuses %s (400)", async (_case, url, body) => {
    expectError(await call("PUT", url, body), 400, "BAD_REQUEST");
  });

  it("refuses a body that isn't JSON (415)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/proxy-connections/p",
      headers: { ...auth, "content-type": "text/plain" },
      payload: "https://api.example.com",
    });

    expectError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
  });
});
