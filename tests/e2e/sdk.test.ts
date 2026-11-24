import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecureCloud } from "../../packages/sdk/src/index.js";
import { freshWindow, GATEWAY_URL, secrets } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PAYMENT_KEY = "local-demo-payment-key";

let cloud: SecureCloud;
let poolId = "";

async function ownerWorkspace() {
  const jar = new Map<string, string>();
  let csrf = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(jar.size
          ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
        ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  const signUp = await call("POST", "/auth/sign-up", {
    email: `e2e-sdk-${randomBytes(4).toString("hex")}@example.test`,
    password: `e2e-sdk-${randomBytes(8).toString("hex")}`,
    workspaceName: "SDK workspace",
  });
  expect(signUp.status).toBe(201);
  const workspace = ((await signUp.json()) as { workspaces: { id: string }[] })
    .workspaces[0]!.id;
  csrf = (
    (await (await call("GET", "/auth/csrf")).json()) as { csrfToken: string }
  ).csrfToken;
  const pool = await call("POST", `/workspaces/${workspace}/user-pools`, {
    name: "SDK users",
  });
  const key = await call("POST", `/workspaces/${workspace}/api-keys`, {
    name: "express-app",
  });
  expect(
    (
      await call("POST", `/workspaces/${workspace}/flags`, {
        key: "new-checkout",
        description: "Only chosen users",
        kind: "boolean",
        offValue: false,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call(
        "PUT",
        `/workspaces/${workspace}/flags/new-checkout/environments/production`,
        {
          enabled: true,
          rules: [
            {
              conditions: [
                {
                  attribute: "email",
                  operator: "in",
                  values: ["chosen@example.test"],
                },
              ],
              value: true,
            },
          ],
          defaultValue: false,
        },
      )
    ).status,
  ).toBe(200);
  return {
    poolId: ((await pool.json()) as { id: string }).id,
    apiKey: ((await key.json()) as { key: string }).key,
  };
}

beforeAll(async () => {
  await freshWindow();
  const owner = await ownerWorkspace();
  poolId = owner.poolId;
  cloud = new SecureCloud({ apiKey: owner.apiKey, url: GATEWAY_URL });

  expect(
    (await secrets(owner.apiKey, "PUT", "/payment-key", PAYMENT_KEY)).status,
  ).toBe(201);
  const connection = await fetch(
    `${GATEWAY_URL}/v1/proxy-connections/payments`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "http://mock-upstream:4000/api/payments",
        secretName: "payment-key",
        headerName: "Authorization",
        headerPrefix: "Bearer ",
      }),
    },
  );
  expect(connection.status).toBe(201);
});

describe("the SDK on the running stack", () => {
  beforeEach(() => freshWindow());

  it("charges through a connection: the provider gets the key the app never had", async () => {
    const charge = await cloud.connections.call<{ id: string; status: string }>(
      "payments",
      "POST /charges",
      { amount: 1849, currency: "sgd", description: "SDK test order" },
    );
    expect(charge.status).toBe(201);
    expect(charge.data).toMatchObject({ status: "succeeded" });

    const declined = await cloud.connections.call("payments", "POST /charges", {
      amount: 250_000,
      currency: "sgd",
      description: "too much",
    });
    expect(declined).toMatchObject({ status: 402, ok: false });

    await expect(
      cloud.connections.call("nope", "/charges"),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("uploads, lists, downloads and deletes a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-sdk-"));
    const source = join(dir, "invoice 2026.txt");
    writeFileSync(source, "Invoice for order 1849\n");

    const uploaded = await cloud.files.upload(source);
    expect(uploaded).toMatchObject({
      name: "invoice 2026.txt",
      contentType: "text/plain",
    });
    expect((await cloud.files.list()).map((f) => f.id)).toContain(uploaded.id);
    expect(await cloud.files.get(uploaded.id)).toMatchObject({ size: 23 });

    const copy = join(dir, "copy.txt");
    await cloud.files.download(uploaded.id, copy);
    expect(readFileSync(copy, "utf8")).toBe("Invoice for order 1849\n");

    await cloud.files.delete(uploaded.id);
    await expect(cloud.files.get(uploaded.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("signs a user up and in, and verifies their token locally", async () => {
    const users = cloud.userPool(poolId);
    const password = `sdk-user-${randomBytes(8).toString("hex")}`;
    await users.signUp({
      email: "ada@example.test",
      password,
      attributes: { plan: "pro" },
    });
    await expect(
      users.signIn({ email: "ada@example.test", password: "wrong password!" }),
    ).rejects.toMatchObject({ status: 401 });

    const session = await users.signIn({ email: "ada@example.test", password });
    const user = await users.verify(session.accessToken);
    expect(user).toMatchObject({
      email: "ada@example.test",
      attributes: { plan: "pro" },
    });

    const next = await users.refresh(session.refreshToken);
    await expect(users.refresh(session.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
    await users.signOut(next.refreshToken);
    await expect(users.refresh(next.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("manages roles; permissions arrive in the user's token", async () => {
    const users = cloud.userPool(poolId);
    await users.createRole({
      name: "support",
      description: "Answers customers",
      permissions: ["orders:read", "orders:refund"],
    });
    await users.createRole({ name: "editor", permissions: ["posts:*"] });
    await expect(
      users.createRole({ name: "support", permissions: [] }),
    ).rejects.toMatchObject({ status: 409 });

    const password = `sdk-roles-${randomBytes(8).toString("hex")}`;
    const user = await users.signUp({ email: "grace@example.test", password });
    expect((await users.addRole(user.id, "support")).roles).toEqual([
      "support",
    ]);
    await users.addRole(user.id, "editor");

    const session = await users.signIn({
      email: "grace@example.test",
      password,
    });
    const signedIn = await users.verify(session.accessToken);
    expect(signedIn.roles).toEqual(["editor", "support"]);
    expect(signedIn.permissions).toEqual([
      "orders:read",
      "orders:refund",
      "posts:*",
    ]);

    await users.updateRole("support", { permissions: ["orders:read"] });
    await users.removeRole(user.id, "editor");
    const next = await users.refresh(session.refreshToken);
    expect(await users.verify(next.accessToken)).toMatchObject({
      roles: ["support"],
      permissions: ["orders:read"],
    });

    expect((await users.listRoles()).map((r) => [r.name, r.userCount])).toEqual(
      [
        ["editor", 0],
        ["support", 1],
      ],
    );
    await users.deleteRole("support");
    expect((await users.getUser(user.id)).roles).toEqual([]);
  });
});

describe("feature flags through the SDK", () => {
  it("a chosen user sees the feature, everyone else doesn't, and other environments are off", async () => {
    const flags = cloud.flags("production");

    expect(
      await flags.isOn("new-checkout", {
        id: "user-1",
        email: "chosen@example.test",
      }),
    ).toBe(true);
    expect(
      await flags.isOn("new-checkout", {
        id: "user-2",
        email: "someone@example.test",
      }),
    ).toBe(false);
    expect(
      await cloud.flags("staging").evaluate({ id: "user-1" }, ["new-checkout"]),
    ).toEqual({ "new-checkout": { value: false, reason: "off" } });
  });
});
