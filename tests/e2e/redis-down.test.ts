import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  compose,
  createTenantWithKey,
  download,
  expectError,
  freshWindow,
  GATEWAY_URL,
  sleep,
} from "./helpers.js";

let key = "";
let startedAt = "";

beforeAll(async () => {
  startedAt = new Date().toISOString();
  await freshWindow();
  ({ key } = await createTenantWithKey("e2e-redis-down"));
  compose("stop", "redis");
});

afterAll(async () => {
  compose("start", "redis");
  for (let i = 0; i < 60; i++) {
    const ready = (await (await fetch(`${GATEWAY_URL}/ready`)).json()) as {
      status: string;
    };
    if (ready.status === "ready") return;
    await sleep(500);
  }
  throw new Error("Redis did not come back");
});

describe("when Redis is down", () => {
  it("still serves API requests with a valid key, without rate limits", async () => {
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        download("00000000-0000-4000-8000-000000000000", `Bearer ${key}`),
      ),
    );

    expect(responses.every((r) => r.status === 404)).toBe(true);
    expect(responses[0]?.headers.get("ratelimit-limit")).toBeNull();
  });

  it("refuses failed key attempts with 503", async () => {
    await expectError(
      await download("x", "Bearer wrong"),
      503,
      "SERVICE_UNAVAILABLE",
    );
  });

  it("refuses admin requests with 503", async () => {
    await expectError(
      await admin("POST", "/tenants", { name: "x" }),
      503,
      "SERVICE_UNAVAILABLE",
    );
  });

  it("reports degraded readiness, and stays alive", async () => {
    const ready = await fetch(`${GATEWAY_URL}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "degraded",
      checks: { postgres: "up", redis: "down" },
    });

    expect((await fetch(`${GATEWAY_URL}/health`)).status).toBe(200);
  });

  it("logs a clear warning", () => {
    expect(
      compose("logs", "gateway", "--no-color", "--since", startedAt),
    ).toContain("WITHOUT rate limits");
  });
});
