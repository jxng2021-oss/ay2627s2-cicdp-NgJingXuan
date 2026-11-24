import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { freshWindow, GATEWAY_URL, LIMITS, psql, sleep } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-dashboard-${randomBytes(8).toString("hex")}`;

class Browser {
  readonly jar = new Map<string, string>();
  csrf = "";
  setCookies: string[] = [];

  async call(method: string, path: string, body?: unknown, raw?: Buffer) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(raw ? { "content-type": "application/octet-stream" } : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const set = response.headers.getSetCookie();
    if (set.length > 0) this.setCookies = set;
    for (const line of set) {
      const pair = line.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    return response;
  }

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async signUp(email: string): Promise<string> {
    const response = await this.call("POST", "/auth/sign-up", {
      email,
      password: PASSWORD,
      workspaceName: `${email}'s workspace`,
    });
    expect(response.status).toBe(201);
    this.csrf = (
      (await (await this.call("GET", "/auth/csrf")).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    return ((await response.json()) as { workspaces: { id: string }[] })
      .workspaces[0]!.id;
  }
}

const email = (name: string) =>
  `e2e-${name}-${randomBytes(4).toString("hex")}@example.test`;

beforeAll(freshWindow);

describe("silent refresh (docs/decisions/0037)", () => {
  it("an expired access token is renewed by the gateway within the request, and the CSRF token keeps working", async () => {
    const browser = new Browser();
    await browser.signUp(email("refresh"));
    const before = new Map(browser.jar);

    await sleep(LIMITS.sessionAccessTtlMs + 500);
    const me = await browser.call("GET", "/auth/me");

    expect(me.status).toBe(200);
    expect(browser.setCookies).toHaveLength(2);
    expect(browser.jar.get("scp_session")).not.toBe(before.get("scp_session"));
    expect(browser.jar.get("scp_refresh")).not.toBe(before.get("scp_refresh"));
    expect(browser.setCookies[1]).toMatch(/; Max-Age=(2591999|2592000);/);
    const logout = await browser.call("POST", "/auth/logout");
    expect(logout.status).toBe(204);

    const replay = await fetch(`${GATEWAY_URL}/dashboard/v1/auth/me`, {
      headers: {
        origin: ORIGIN,
        cookie: `scp_refresh=${before.get("scp_refresh")}`,
      },
    });
    expect(replay.status).toBe(401);
  });
});

describe("the dashboard API", () => {
  it("sign up, create a secret (never readable back), upload a file and read the audit log", async () => {
    const owner = new Browser();
    const workspace = await owner.signUp(email("owner"));
    expect(owner.setCookies[0]).toMatch(
      /^scp_session=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=\d+; HttpOnly; SameSite=Lax$/,
    );
    expect(owner.setCookies[1]).toMatch(
      /^scp_refresh=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=(2591999|2592000); HttpOnly; SameSite=Strict$/,
    );

    const ws = `/workspaces/${workspace}`;
    const secret = await owner.call("PUT", `${ws}/secrets/e2e-dashboard`, {
      value: "e2e-secret-value-dashboard",
    });
    const file = Buffer.from(
      `e2e-file-content-dashboard-${randomBytes(4).toString("hex")}`,
    );
    const uploaded = await owner.call("POST", `${ws}/files`, undefined, file);
    const { id } = (await uploaded.json()) as { id: string };
    const downloaded = await owner.call("GET", `${ws}/files/${id}`);
    const list = await owner.call("GET", `${ws}/secrets`);
    const revealed = await owner.call(
      "POST",
      `${ws}/secrets/e2e-dashboard/reveal`,
    );
    const overview = await owner.call("GET", ws);

    expect([
      secret.status,
      uploaded.status,
      downloaded.status,
      revealed.status,
    ]).toEqual([201, 201, 200, 404]);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(file)).toBe(true);
    expect(await list.text()).not.toContain("e2e-secret-value-dashboard");
    expect(await revealed.text()).not.toContain("e2e-secret-value-dashboard");
    expect(await overview.json()).toMatchObject({
      role: "owner",
      secretsCount: 1,
      fileCount: 1,
      secretsSealed: false,
    });

    let actions: string[] = [];
    for (let i = 0; i < 20 && !actions.includes("file.uploaded"); i++) {
      const events = await owner.call("GET", `${ws}/audit-events?limit=50`);
      actions = (
        (await events.json()) as {
          events: { action: string; actorType: string }[];
        }
      ).events.map((e) => e.action);
      await sleep(250);
    }
    expect(actions).toEqual(
      expect.arrayContaining([
        "user.signed_up",
        "secret.created",
        "file.uploaded",
      ]),
    );
  });

  it("an owner removes a revoked API key for good, and filters the audit log by several actions", async () => {
    const owner = new Browser();
    const ws = `/workspaces/${await owner.signUp(email("keys"))}`;
    const created = await owner.call("POST", `${ws}/api-keys`, {
      name: "old-server",
    });
    const { apiKey, key } = (await created.json()) as {
      apiKey: { id: string };
      key: string;
    };
    const whileActive = await owner.call(
      "DELETE",
      `${ws}/revoked-api-keys/${apiKey.id}`,
    );
    const revoked = await owner.call("DELETE", `${ws}/api-keys/${apiKey.id}`);
    const removed = await owner.call(
      "DELETE",
      `${ws}/revoked-api-keys/${apiKey.id}`,
    );
    const list = await owner.call("GET", `${ws}/api-keys`);
    const used = await fetch(`${GATEWAY_URL}/v1/secrets`, {
      headers: { authorization: `Bearer ${key}` },
    });

    expect([whileActive.status, revoked.status, removed.status]).toEqual([
      409, 204, 204,
    ]);
    expect(await list.text()).not.toContain(apiKey.id);
    expect(used.status).toBe(401);

    let events: { action: string; resourceId: string | null }[] = [];
    for (let i = 0; i < 20 && events.length < 2; i++) {
      const page = await owner.call(
        "GET",
        `${ws}/audit-events?action=api_key.revoked&action=api_key.deleted&outcome=success`,
      );
      expect(page.status).toBe(200);
      events = ((await page.json()) as { events: typeof events }).events;
      await sleep(250);
    }
    expect(events.map((e) => [e.action, e.resourceId])).toEqual([
      ["api_key.deleted", apiKey.id],
      ["api_key.revoked", apiKey.id],
    ]);
  });

  it("two users can't reach each other's workspaces", async () => {
    const a = new Browser();
    const b = new Browser();
    const aWorkspace = await a.signUp(email("a"));
    const bWorkspace = await b.signUp(email("b"));
    await a.call("PUT", `/workspaces/${aWorkspace}/secrets/only-a`, {
      value: "e2e-secret-value-only-a",
    });

    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/secrets"],
      ["GET", "/files"],
      ["GET", "/audit-events"],
      ["POST", "/api-keys"],
    ] as const) {
      const response = await b.call(
        method,
        `/workspaces/${aWorkspace}${path}`,
        method === "POST" && path === "/api-keys" ? { name: "x" } : undefined,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(
      (await a.call("GET", `/workspaces/${bWorkspace}/secrets`)).status,
    ).toBe(404);
  });

  it("refuses a wrong Origin, a missing CSRF token, and API keys", async () => {
    const browser = new Browser();
    const workspace = await browser.signUp(email("csrf"));

    const wrongOrigin = await fetch(
      `${GATEWAY_URL}/dashboard/v1/workspaces/${workspace}/secrets/x`,
      {
        method: "PUT",
        headers: {
          origin: "https://evil.example",
          cookie: browser.cookie,
          "x-csrf-token": browser.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: "x" }),
      },
    );
    const noToken = await fetch(
      `${GATEWAY_URL}/dashboard/v1/workspaces/${workspace}/files`,
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: browser.cookie,
          "content-type": "application/octet-stream",
        },
        body: "x",
      },
    );
    const created = await browser.call(
      "POST",
      `/workspaces/${workspace}/api-keys`,
      { name: "e2e" },
    );
    const { key } = (await created.json()) as { key: string };
    const keyOnDashboard = await fetch(`${GATEWAY_URL}/dashboard/v1/auth/me`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const cookieOnV1 = await fetch(`${GATEWAY_URL}/v1/secrets`, {
      headers: { cookie: browser.cookie },
    });

    expect([
      wrongOrigin.status,
      noToken.status,
      keyOnDashboard.status,
      cookieOnV1.status,
    ]).toEqual([403, 403, 401, 401]);
  });

  it("stores no passwords, session tokens or CSRF tokens in plain text", async () => {
    const browser = new Browser();
    await browser.signUp(email("stored"));

    const dump = psql(
      "platform",
      "platform",
      "select * from users; select * from sessions;",
    ).output;
    const auditDump = psql(
      "platform",
      "audit",
      "select * from audit_events",
    ).output;
    for (const secret of [PASSWORD, ...browser.jar.values(), browser.csrf]) {
      expect(dump).not.toContain(secret);
      expect(auditDump).not.toContain(secret);
    }
    expect(dump).toContain("$argon2id$");
  });
});
