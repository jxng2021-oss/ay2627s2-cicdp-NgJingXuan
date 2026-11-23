import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  call,
  createPool,
  newTenant,
  PASSWORD,
  signUp,
  startIdentity,
  type Tokens,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/identity.openapi.json"));

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

describe("the identity service meets the internal contract", () => {
  it("every route, with its successes and errors", async () => {
    const { app, vault } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "contract@example.com", {
      attributes: { plan: "pro", seats: 3, beta: true },
    });
    const missing = randomUUID();
    const checks: [string, string, unknown?][] = [
      ["GET", "/pools"],
      ["POST", "/pools", { name: "Second", minPasswordLength: 14 }],
      ["POST", "/pools", { name: "Second" }],
      ["POST", "/pools", { name: "" }],
      ["GET", `/pools/${pool}`],
      ["GET", `/pools/${missing}`],
      ["PATCH", `/pools/${pool}`, { accessTokenTtlSeconds: 600 }],
      ["GET", `/pools/${pool}/users?limit=1`],
      [
        "POST",
        `/pools/${pool}/users`,
        { email: "contract@example.com", password: PASSWORD },
      ],
      ["GET", `/pools/${pool}/users/${user}`],
      ["GET", `/pools/${pool}/users/${missing}`],
      [
        "PATCH",
        `/pools/${pool}/users/${user}`,
        { attributes: { plan: "max" } },
      ],
      [
        "POST",
        `/pools/${pool}/users/${user}/password`,
        { currentPassword: "wrong-one-123", newPassword: `${PASSWORD}x` },
      ],
      [
        "POST",
        `/pools/${pool}/sessions`,
        { email: "contract@example.com", password: "wrong-one-123" },
      ],
      [
        "POST",
        `/pools/${pool}/sessions/refresh`,
        { refreshToken: "x".repeat(43) },
      ],
      [
        "POST",
        `/pools/${pool}/sessions/revoke`,
        { refreshToken: "x".repeat(43) },
      ],
    ];
    for (const [method, url, body] of checks) {
      const response = await call(
        app,
        tenant,
        method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        body,
      );
      expectContract(method, url.split("?")[0]!, response);
    }

    const login = await call(app, tenant, "POST", `/pools/${pool}/sessions`, {
      email: "contract@example.com",
      password: PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    expectContract("POST", `/pools/${pool}/sessions`, login);
    const refreshed = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/sessions/refresh`,
      {
        refreshToken: login.json<Tokens>().refreshToken,
      },
    );
    expectContract("POST", `/pools/${pool}/sessions/refresh`, refreshed);

    const reset = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${user}/reset-password`,
    );
    expectContract(
      "POST",
      `/pools/${pool}/users/${user}/reset-password`,
      reset,
    );
    const unlocked = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${user}/unlock`,
    );
    expect(unlocked.statusCode).toBe(200);
    expectContract("POST", `/pools/${pool}/users/${user}/unlock`, unlocked);
    const noUser = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${missing}/unlock`,
    );
    expect(noUser.statusCode).toBe(404);
    expectContract("POST", `/pools/${pool}/users/${missing}/unlock`, noUser);

    const jwks = await app.inject({
      method: "GET",
      url: `/public/pools/${pool}/jwks`,
    });
    expectContract("GET", `/public/pools/${pool}/jwks`, jwks);
    const noJwks = await app.inject({
      method: "GET",
      url: `/public/pools/${missing}/jwks`,
    });
    expectContract("GET", `/public/pools/${missing}/jwks`, noJwks);

    vault.sealed = true;
    const sealed = await call(app, tenant, "POST", `/pools/${pool}/sessions`, {
      email: "contract@example.com",
      password: PASSWORD,
    });
    expect(sealed.statusCode).toBe(503);
    expectContract("POST", `/pools/${pool}/sessions`, sealed);
    vault.sealed = false;

    for (const [method, url] of [
      ["DELETE", `/pools/${pool}/users/${user}`],
      ["DELETE", `/pools/${pool}`],
      ["DELETE", "/tenant"],
    ] as const) {
      const response = await call(app, tenant, method, url);
      expect(response.statusCode).toBe(204);
      expectContract(method, url, response);
    }
    for (const url of ["/health", "/ready"]) {
      expectContract("GET", url, await app.inject({ method: "GET", url }));
    }
  });
});
