import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { freshWindow, GATEWAY_URL } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-flags-${randomBytes(8).toString("hex")}`;

class Browser {
  private readonly jar = new Map<string, string>();
  csrf = "";

  async call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.jar.size
          ? {
              cookie: [...this.jar]
                .map(([name, value]) => `${name}=${value}`)
                .join("; "),
            }
          : {}),
        ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    return response;
  }
}

const owner = new Browser();
let workspace = "";
let apiKey = "";

function evaluate(context: object) {
  return fetch(`${GATEWAY_URL}/v1/flags/evaluate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ environment: "production", context }),
  });
}

beforeAll(async () => {
  await freshWindow();
  const signUp = await owner.call("POST", "/auth/sign-up", {
    email: `e2e-flags-${randomBytes(4).toString("hex")}@example.test`,
    password: PASSWORD,
    workspaceName: "Flags workspace",
  });
  expect(signUp.status).toBe(201);
  workspace = ((await signUp.json()) as { workspaces: { id: string }[] })
    .workspaces[0]!.id;
  owner.csrf = (
    (await (await owner.call("GET", "/auth/csrf")).json()) as {
      csrfToken: string;
    }
  ).csrfToken;
  const key = await owner.call("POST", `/workspaces/${workspace}/api-keys`, {
    name: "flags-app",
  });
  apiKey = ((await key.json()) as { key: string }).key;
});

describe("feature flags", () => {
  it("a flag targeted in the dashboard is served to the app through /v1", async () => {
    const created = await owner.call("POST", `/workspaces/${workspace}/flags`, {
      key: "sale-banner",
      description: "The holiday sale banner",
      kind: "boolean",
      offValue: false,
    });
    expect(created.status).toBe(201);

    let values = (await (await evaluate({ key: "ada" })).json()) as {
      flags: Record<string, { value: unknown; reason: string }>;
    };
    expect(values.flags["sale-banner"]).toEqual({
      value: false,
      reason: "off",
    });

    const targeted = await owner.call(
      "PUT",
      `/workspaces/${workspace}/flags/sale-banner/environments/production`,
      {
        enabled: true,
        rules: [
          {
            conditions: [
              { attribute: "country", operator: "equals", values: ["SG"] },
            ],
            value: true,
          },
        ],
        defaultValue: false,
      },
    );
    expect(targeted.status).toBe(200);

    values = (await (
      await evaluate({ key: "ada", attributes: { country: "SG" } })
    ).json()) as typeof values;
    expect(values.flags["sale-banner"]).toEqual({
      value: true,
      reason: "rule",
      ruleIndex: 0,
    });
    values = (await (
      await evaluate({ key: "bob", attributes: { country: "MY" } })
    ).json()) as typeof values;
    expect(values.flags["sale-banner"]).toEqual({
      value: false,
      reason: "default",
    });
  });

  it("every change is in the workspace's audit log", async () => {
    const off = await owner.call(
      "PUT",
      `/workspaces/${workspace}/flags/sale-banner/environments/production`,
      {
        enabled: false,
        rules: [
          {
            conditions: [
              { attribute: "country", operator: "equals", values: ["SG"] },
            ],
            value: true,
          },
        ],
        defaultValue: false,
      },
    );
    expect(off.status).toBe(200);
    const events = await fetch(
      `${GATEWAY_URL}/v1/audit-events?resourceType=feature_flag&limit=10`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    const actions = (
      (await events.json()) as { events: { action: string }[] }
    ).events
      .map((event) => event.action)
      .reverse();
    expect(actions).toEqual([
      "feature_flag.created",
      "feature_flag.updated",
      "feature_flag.toggled",
    ]);
  });
});
