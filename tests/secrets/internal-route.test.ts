import { describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import { call, newTenant, startSecrets, testKeyProvider } from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/secrets.openapi.json"));

function expectContract(
  url: string,
  response: Awaited<ReturnType<typeof call>>,
) {
  expect(
    contract.checkResponse("GET", url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
}

describe("GET /internal/secrets/:name", () => {
  it("returns the latest value, marked no-store, and follows rotation", async () => {
    const app = await startSecrets();
    const tenant = newTenant();
    await call(app, tenant, "PUT", "/secrets/api-token", "first");

    const first = await call(app, tenant, "GET", "/internal/secrets/api-token");
    await call(app, tenant, "POST", "/secrets/api-token/rotate", "second");
    const second = await call(
      app,
      tenant,
      "GET",
      "/internal/secrets/api-token",
    );

    expect(first.json()).toEqual({
      name: "api-token",
      version: 1,
      value: "first",
    });
    expect(second.json()).toEqual({
      name: "api-token",
      version: 2,
      value: "second",
    });
    expect(second.headers["cache-control"]).toBe("no-store");
    expectContract("/internal/secrets/api-token", first);
  });

  it("is 404 for a missing secret and for another tenant's", async () => {
    const app = await startSecrets();
    const tenant = newTenant();
    await call(app, tenant, "PUT", "/secrets/mine", "value");

    const missing = await call(app, tenant, "GET", "/internal/secrets/nope");
    const other = await call(app, newTenant(), "GET", "/internal/secrets/mine");

    expect([missing.statusCode, other.statusCode]).toEqual([404, 404]);
    expect(other.body).not.toContain("value");
    expectContract("/internal/secrets/nope", missing);
  });

  it("is 503 SECRETS_SEALED while sealed, and 400 for a bad name", async () => {
    const keys = testKeyProvider();
    keys.state = "sealed";
    const app = await startSecrets({ keyProvider: keys });
    const tenant = newTenant();

    const sealed = await call(app, tenant, "GET", "/internal/secrets/x");
    const bad = await call(
      await startSecrets(),
      tenant,
      "GET",
      "/internal/secrets/-bad",
    );

    expect(sealed.statusCode).toBe(503);
    expect(sealed.json()).toMatchObject({ error: { code: "SECRETS_SEALED" } });
    expect(bad.statusCode).toBe(400);
    expectContract("/internal/secrets/x", sealed);
  });
});
