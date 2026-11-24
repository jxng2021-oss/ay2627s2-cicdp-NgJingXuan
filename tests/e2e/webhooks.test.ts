import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SecureCloud } from "../../packages/sdk/src/index.js";
import { freshWindow, GATEWAY_URL } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-webhooks-${randomBytes(8).toString("hex")}`;
const WHSEC = `whsec_e2e${randomBytes(16).toString("hex")}`;

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
let endpointId = "";

function stripeEvent(id: string, object: Record<string, unknown>) {
  return JSON.stringify({
    id,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
}

function fromStripe(body: string, secret = WHSEC) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return fetch(`${GATEWAY_URL}/v1/webhooks/${endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${v1}`,
    },
    body,
  });
}

beforeAll(async () => {
  await freshWindow();
  const signUp = await owner.call("POST", "/auth/sign-up", {
    email: `e2e-webhooks-${randomBytes(4).toString("hex")}@example.test`,
    password: PASSWORD,
    workspaceName: "Webhooks workspace",
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
    name: "webhooks-app",
  });
  apiKey = ((await key.json()) as { key: string }).key;
  const secret = await fetch(
    `${GATEWAY_URL}/v1/secrets/stripe-webhook-secret`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: WHSEC }),
    },
  );
  expect(secret.status).toBe(201);
  const endpoint = await owner.call(
    "POST",
    `/workspaces/${workspace}/webhooks`,
    {
      name: "stripe",
      signingSecretName: "stripe-webhook-secret",
      forwardUrl: null,
    },
  );
  expect(endpoint.status).toBe(201);
  endpointId = ((await endpoint.json()) as { id: string }).id;
});

describe("payment webhooks", () => {
  it("a signed Stripe event reaches the dev app as a clean event it can pull", async () => {
    const cloud = new SecureCloud({ apiKey, url: GATEWAY_URL });
    const before = await cloud.webhooks.events({ endpointId });
    expect(before.events).toEqual([]);

    const body = stripeEvent("evt_e2e_1", {
      id: "cs_test_e2e",
      payment_status: "paid",
      amount_total: 4200,
      currency: "sgd",
      payment_intent: "pi_e2e",
      metadata: { order_id: "order-e2e" },
    });
    expect((await fromStripe(body)).status).toBe(200);
    expect((await fromStripe(body)).status).toBe(200);

    const page = await cloud.webhooks.events({ endpointId });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      endpointId,
      event: "payment.succeeded",
      orderId: "order-e2e",
      amount: 4200,
      paymentId: "pi_e2e",
    });
    expect(JSON.stringify(page)).not.toContain(WHSEC);
    expect(await cloud.webhooks.events({ after: page.next })).toEqual({
      events: [],
      next: page.next,
    });
  });

  it("refuses events not signed with the workspace's Stripe secret", async () => {
    const body = stripeEvent("evt_e2e_2", { payment_status: "paid" });
    const refused = await fromStripe(body, "whsec_not_the_right_one");
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain("whsec");
  });

  it("publishes secure-cloud's public key, and records endpoint changes in the audit log", async () => {
    const keys = await fetch(`${GATEWAY_URL}/v1/webhooks/keys`);
    expect(keys.status).toBe(200);
    const { keys: list } = (await keys.json()) as {
      keys: { kty: string; crv: string; alg: string; d?: string }[];
    };
    expect(list[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
    expect(list[0]!.d).toBeUndefined();

    const audit = await owner.call(
      "GET",
      `/workspaces/${workspace}/audit-events?action=webhook_endpoint.created`,
    );
    const events = (
      (await audit.json()) as { events: { resourceId: string }[] }
    ).events;
    expect(events.map((e) => e.resourceId)).toContain(endpointId);
  });
});
