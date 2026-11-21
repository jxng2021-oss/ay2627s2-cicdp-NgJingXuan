import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  createTenantWithKey,
  expectError,
  freshWindow,
  GATEWAY_URL,
  secrets,
} from "./helpers.js";
import { dockerCompose, secretsOperator, unsealWith } from "./operator.js";

const shares = inject("unsealShares");
const contract = new Contract(loadSpec("api/openapi.v1.json"));
const KEY = "e2e-secret-value-outside-api-key-7c1f";
let apiKey = "";

function proxy(path: string, init: RequestInit = {}) {
  return fetch(`${GATEWAY_URL}/v1/proxy${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
  });
}

function putConnection(name: string, body: object, key = apiKey) {
  return fetch(`${GATEWAY_URL}/v1/proxy-connections/${name}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function recordedRequests(): Promise<
  { headers: Record<string, string> }[]
> {
  const result = await dockerCompose([
    "exec",
    "-T",
    "mock-upstream",
    "node",
    "-e",
    "fetch('http://127.0.0.1:4000/__requests').then(r=>r.text()).then(console.log)",
  ]);
  return (
    JSON.parse(result.stdout) as {
      requests: { headers: Record<string, string> }[];
    }
  ).requests;
}

async function expectContract(
  method: string,
  path: string,
  response: Response,
) {
  const body = await response.clone().text();
  expect(
    contract.checkResponse(method, path, {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    }),
  ).toEqual([]);
}

beforeAll(async () => {
  await freshWindow();
  ({ key: apiKey } = await createTenantWithKey("e2e-proxy"));
  expect((await secrets(apiKey, "PUT", "/mock-api-key", KEY)).status).toBe(201);
  const created = await putConnection("mock", {
    baseUrl: "http://mock-upstream:4000/api",
    secretName: "mock-api-key",
    headerName: "X-Api-Key",
  });
  expect(created.status).toBe(201);
  await dockerCompose([
    "exec",
    "-T",
    "mock-upstream",
    "node",
    "-e",
    "fetch('http://127.0.0.1:4000/__requests',{method:'DELETE'})",
  ]);
});

afterAll(async () => {
  await unsealWith(shares);
});

describe("the proxy route", () => {
  it("adds the stored key for the outside API, and never returns or logs it", async () => {
    const response = await proxy("/mock/record?x=1", {
      headers: {
        cookie: "session=client",
        "x-tenant-id": "11111111-1111-4111-8111-111111111111",
        "x-api-key": "client-own-key",
      },
    });
    const body = await response.text();
    const [seen] = await recordedRequests();
    const logs = (await dockerCompose(["logs", "--no-color"])).stdout;

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ recorded: true });
    expect(seen?.headers["x-api-key"]).toBe(KEY);
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers["x-tenant-id"]).toBeUndefined();
    expect(JSON.stringify(seen?.headers)).not.toContain(apiKey);
    expect(body).not.toContain(KEY);
    expect(JSON.stringify([...response.headers])).not.toContain(KEY);
    expect(logs).not.toContain(KEY);
  });

  it("passes the outside API's answer back, streaming bodies both ways", async () => {
    const response = await proxy("/mock/orders/42?expand=items", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(100_000, 1),
    });

    expect(await response.json()).toMatchObject({
      ok: true,
      method: "POST",
      path: "/api/orders/42",
      query: { expand: "items" },
      bodyBytes: 100_000,
    });
  });

  it("doesn't follow redirects, and passes the outside API's own errors through", async () => {
    const redirect = await proxy("/mock/redirect");
    const failure = await proxy("/mock/error");

    await expectContract("GET", "/v1/proxy/mock/redirect", redirect);
    await expectError(redirect, 502, "UPSTREAM_REDIRECT");
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ mock: "the outside API failed" });
  });

  it("uses a rotated secret on the next request", async () => {
    await secrets(apiKey, "POST", "/mock-api-key/rotate", `${KEY}-rotated`);
    await proxy("/mock/record");

    const requests = await recordedRequests();
    expect(requests.at(-1)?.headers["x-api-key"]).toBe(`${KEY}-rotated`);
  });

  it("503 SECRETS_SEALED while sealed, and works again once unsealed", async () => {
    await secretsOperator(["seal"]);
    const sealed = await proxy("/mock/anything");
    await expectContract("GET", "/v1/proxy/mock/anything", sealed);
    await expectError(sealed, 503, "SECRETS_SEALED");

    await unsealWith(shares);
    expect((await proxy("/mock/anything")).status).toBe(200);
  });

  it("refuses connections to hosts that aren't allowed", async () => {
    for (const baseUrl of [
      "http://secrets:3002",
      "http://gateway:8080",
      "http://169.254.169.254/latest",
      "https://example.com",
      "http://user:pass@mock-upstream:4000",
    ]) {
      const response = await putConnection("bad", {
        baseUrl,
        secretName: "mock-api-key",
        headerName: "X-Api-Key",
      });
      await expectError(response, 400, "BAD_REQUEST");
    }
  });

  it("can't read the mock's test-only endpoint above the base path", async () => {
    for (const path of [
      "/mock/..%2f__requests",
      "/mock/%2e%2e/__requests",
      "/mock/../__requests",
    ]) {
      const response = await proxy(path);
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(KEY);
    }
  });

  it("the secrets service's internal route can't be reached through the gateway", async () => {
    for (const path of [
      "/v1/internal/secrets/mock-api-key",
      "/internal/secrets/mock-api-key",
    ]) {
      const response = await fetch(`${GATEWAY_URL}${path}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(KEY);
    }
  });

  it("another tenant can't use the connection", async () => {
    const other = await createTenantWithKey("e2e-proxy-other");

    const response = await fetch(`${GATEWAY_URL}/v1/proxy/mock/record`, {
      headers: { authorization: `Bearer ${other.key}` },
    });

    await expectError(response, 404, "NOT_FOUND");
  });
});
