import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import { call, createFlag, newTenant, startFlags } from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/flags.openapi.json"));
function expectContract(
  method: string,
  url: string,
  response: LightMyRequestResponse,
) {
  expect(
    contract.checkResponse(method, url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
}

const production = (settings: object) => ({
  enabled: true,
  rules: [],
  defaultValue: false,
  ...settings,
});

describe("flags", () => {
  it("creates a flag, off in every environment, and records it", async () => {
    const { app, audit } = await startFlags();
    const tenant = newTenant();

    const response = await call(app, tenant, "POST", "/flags", {
      key: "new-checkout",
      description: "The redesigned checkout",
      kind: "boolean",
      offValue: false,
    });

    expect(response.statusCode).toBe(201);
    expectContract("POST", "/flags", response);
    const flag = response.json<{
      environments: Record<string, { enabled: boolean }>;
    }>();
    expect(Object.values(flag.environments).every((env) => !env.enabled)).toBe(
      true,
    );
    expect(audit.events.map((e) => e.action)).toEqual(["feature_flag.created"]);

    const duplicate = await call(app, tenant, "POST", "/flags", {
      key: "new-checkout",
      kind: "boolean",
      offValue: false,
    });
    expect(duplicate.statusCode).toBe(409);
    expectContract("POST", "/flags", duplicate);
  });

  it("refuses values of the wrong kind and bad keys", async () => {
    const { app } = await startFlags();
    const tenant = newTenant();
    await createFlag(app, tenant);
    expect(
      (
        await call(app, tenant, "POST", "/flags", {
          key: "x",
          kind: "boolean",
          offValue: "no",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(app, tenant, "POST", "/flags", {
          key: "Bad Key",
          kind: "string",
          offValue: "a",
        })
      ).statusCode,
    ).toBe(400);
    const wrong = await call(
      app,
      tenant,
      "PUT",
      "/flags/new-checkout/environments/production",
      production({ defaultValue: "yes" }),
    );
    expect(wrong.statusCode).toBe(400);
    expectContract("PUT", "/flags/new-checkout/environments/production", wrong);
  });

  it("records turning a flag on as 'toggled', and other changes as 'updated'", async () => {
    const { app, audit } = await startFlags();
    const tenant = newTenant();
    await createFlag(app, tenant);
    const url = "/flags/new-checkout/environments/production";

    const toggled = await call(app, tenant, "PUT", url, production({}));
    const updated = await call(
      app,
      tenant,
      "PUT",
      url,
      production({ rollout: { percentage: 10, value: true } }),
    );

    expect([toggled.statusCode, updated.statusCode]).toEqual([200, 200]);
    expectContract("PUT", url, updated);
    expect(audit.events.map((e) => e.action)).toEqual([
      "feature_flag.created",
      "feature_flag.toggled",
      "feature_flag.updated",
    ]);
    const flag = (await call(app, tenant, "GET", "/flags/new-checkout")).json<{
      environments: Record<string, { enabled: boolean }>;
    }>();
    expect(flag.environments.production!.enabled).toBe(true);
    expect(flag.environments.staging!.enabled).toBe(false);
  });

  it("evaluates every flag for a user, per environment", async () => {
    const { app } = await startFlags();
    const tenant = newTenant();
    await createFlag(app, tenant, "new-checkout");
    await createFlag(app, tenant, "sale-banner");
    await call(
      app,
      tenant,
      "PUT",
      "/flags/sale-banner/environments/production",
      production({
        rules: [
          {
            conditions: [
              { attribute: "country", operator: "equals", values: ["SG"] },
            ],
            value: true,
          },
        ],
      }),
    );

    const response = await call(app, tenant, "POST", "/evaluate", {
      environment: "production",
      context: { key: "ada", attributes: { country: "SG" } },
    });

    expect(response.statusCode).toBe(200);
    expectContract("POST", "/evaluate", response);
    expect(response.json()).toEqual({
      environment: "production",
      flags: {
        "new-checkout": { value: false, reason: "off" },
        "sale-banner": { value: true, reason: "rule", ruleIndex: 0 },
      },
    });
    const only = await call(app, tenant, "POST", "/evaluate", {
      environment: "staging",
      context: { key: "ada" },
      keys: ["sale-banner", "unknown"],
    });
    expect(Object.keys(only.json<{ flags: object }>().flags)).toEqual([
      "sale-banner",
    ]);
  });

  it("keeps workspaces apart, and deletes a workspace's flags", async () => {
    const { app } = await startFlags();
    const tenant = newTenant();
    const other = newTenant();
    await createFlag(app, tenant);

    const missing = await call(app, other, "GET", "/flags/new-checkout");
    expect(missing.statusCode).toBe(404);
    expectContract("GET", "/flags/new-checkout", missing);
    const theirs = await call(app, other, "POST", "/evaluate", {
      environment: "production",
      context: { key: "ada" },
    });
    expect(theirs.json()).toEqual({ environment: "production", flags: {} });

    const removed = await call(app, tenant, "DELETE", "/tenant");
    expect(removed.statusCode).toBe(204);
    expectContract("DELETE", "/tenant", removed);
    const list = await call(app, tenant, "GET", "/flags");
    expectContract("GET", "/flags", list);
    expect(list.json()).toEqual({ flags: [] });
  });

  it("refuses a change it can't record (503), and keeps nothing", async () => {
    const { app, audit } = await startFlags();
    const tenant = newTenant();
    audit.down = true;
    const response = await call(app, tenant, "POST", "/flags", {
      key: "x",
      kind: "boolean",
      offValue: false,
    });
    expect(response.statusCode).toBe(503);
    audit.down = false;
    expect((await call(app, tenant, "GET", "/flags")).json()).toEqual({
      flags: [],
    });
  });

  it("deletes one flag, recorded", async () => {
    const { app, audit } = await startFlags();
    const tenant = newTenant();
    await createFlag(app, tenant);
    const response = await call(app, tenant, "DELETE", "/flags/new-checkout");
    expect(response.statusCode).toBe(204);
    expectContract("DELETE", "/flags/new-checkout", response);
    expect(audit.events.at(-1)?.action).toBe("feature_flag.deleted");
    expect(
      (await call(app, tenant, "DELETE", "/flags/new-checkout")).statusCode,
    ).toBe(404);
  });
});
