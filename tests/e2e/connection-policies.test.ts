import { beforeAll, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  createTenantWithKey,
  expectError,
  freshWindow,
  GATEWAY_URL,
  psql,
  secrets,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/openapi.v1.json"));
let apiKey = "";
let tenantId = "";

function pay(amount: unknown, path = "charges") {
  return fetch(`${GATEWAY_URL}/v1/proxy/payments/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount, currency: "sgd", description: "e2e" }),
  });
}

async function checked(method: string, path: string, response: Response) {
  const body = await response.clone().text();
  expect(
    contract.checkResponse(method, path, {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    }),
  ).toEqual([]);
  return response;
}

beforeAll(async () => {
  await freshWindow();
  ({ key: apiKey, tenantId } = await createTenantWithKey("e2e-policies"));
  expect(
    (
      await secrets(
        apiKey,
        "PUT",
        "/payment-key",
        process.env.MOCK_PAYMENT_API_KEY ?? "local-demo-payment-key",
      )
    ).status,
  ).toBe(201);
  const saved = await fetch(`${GATEWAY_URL}/v1/proxy-connections/payments`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      baseUrl: "http://mock-upstream:4000/api/payments",
      secretName: "payment-key",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      policy: {
        allowedRoutes: [{ method: "POST", path: "/charges" }],
        amountLimit: { field: "amount", maxPerRequest: 500, maxPerDay: 800 },
      },
    }),
  });
  expect(saved.status).toBe(201);
});

describe("connection policies", () => {
  it("lets an allowed call through, with the key injected", async () => {
    const response = await pay(300);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toMatch(/^ch_/);
  });

  it("refuses other routes, too-large amounts and the day's overflow (403)", async () => {
    await expectError(
      await checked("POST", "/v1/proxy/payments/{*}", await pay(10, "refunds")),
      403,
      "PROXY_POLICY_DENIED",
    );
    await expectError(
      await checked("POST", "/v1/proxy/payments/{*}", await pay(501)),
      403,
      "PROXY_POLICY_DENIED",
    );
    expect((await pay(400)).status).toBe(201);
    await expectError(
      await checked("POST", "/v1/proxy/payments/{*}", await pay(200)),
      403,
      "PROXY_POLICY_DENIED",
    );

    const usage = await fetch(
      `${GATEWAY_URL}/v1/proxy-connections/payments/usage`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    await checked("GET", "/v1/proxy-connections/{name}/usage", usage);
    expect(await usage.json()).toMatchObject({
      amount: { usedToday: 700, maxPerDay: 800 },
    });
  });

  it("records refusals as proxy_connection.denied, without the body", async () => {
    const countDenied = () =>
      psql(
        "audit_app",
        "audit",
        `select count(*) from audit_events where tenant_id = '${tenantId}' and action = 'proxy_connection.denied' and outcome = 'denied'`,
      );
    let denied = countDenied();
    for (let i = 0; i < 40 && denied.ok && Number(denied.output) < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      denied = countDenied();
    }
    expect(denied.ok, denied.output).toBe(true);
    expect(Number(denied.output)).toBe(3);
    const rows = psql(
      "audit_app",
      "audit",
      `select row_to_json(e)::text from audit_events e where tenant_id = '${tenantId}'`,
    );
    expect(rows.output).not.toMatch(/(?<![0-9a-f])501(?![0-9a-f])/i);
  });
});
