import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_OWNED_WORKSPACES } from "../../services/gateway/src/controllers/dashboard/auth.controller.js";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import type { Database } from "../../services/gateway/src/db/client.js";
import { Browser, COOKIE, PASSWORD } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let audit: FakeAudit;
let alice: Browser;
let workspace: string;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  audit = new FakeAudit();
  app = await startGateway({ db, audit });
  alice = new Browser(app);
  workspace = await alice.signUp("alice@example.com", "Alice's");
});

const ME = "/dashboard/v1/auth/me";

async function userId(browser: Browser): Promise<string> {
  return (await browser.request("GET", ME)).json<{ user: { id: string } }>()
    .user.id;
}

async function bob(role: "owner" | "member"): Promise<Browser> {
  const browser = new Browser(app);
  await browser.signUp("bob@example.com", "Bob's");
  await insertMembership(db, {
    userId: await userId(browser),
    tenantId: workspace,
    role,
  });
  return browser;
}

describe("display name", () => {
  it("sets, shows and clears it, recording IDs only", async () => {
    const saved = await alice.request(
      "PATCH",
      "/dashboard/v1/account/profile",
      {
        body: { displayName: "  Alice Tan " },
      },
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ user: { displayName: "Alice Tan" } });
    expect((await alice.request("GET", ME)).json()).toMatchObject({
      user: { displayName: "Alice Tan" },
    });
    const event = audit.events.find((e) => e.action === "user.profile_updated");
    expect(event).toMatchObject({ tenantId: workspace, actorType: "user" });
    expect(JSON.stringify(event)).not.toContain("Alice Tan");

    const cleared = await alice.request(
      "PATCH",
      "/dashboard/v1/account/profile",
      { body: { displayName: null } },
    );
    expect(cleared.json()).toMatchObject({ user: { displayName: null } });
  });

  it("refuses control characters, overlong names and a missing CSRF token", async () => {
    for (const displayName of ["a\nb", "x".repeat(61), ""]) {
      expectError(
        await alice.request("PATCH", "/dashboard/v1/account/profile", {
          body: { displayName },
        }),
        400,
        "BAD_REQUEST",
      );
    }
    expectError(
      await alice.request("PATCH", "/dashboard/v1/account/profile", {
        body: { displayName: "A" },
        csrf: false,
      }),
      403,
      "FORBIDDEN",
    );
  });
});

describe("sessions", () => {
  it("lists the user's working sessions with where they started", async () => {
    const laptop = new Browser(app);
    await laptop.login("alice@example.com");

    const response = await alice.request(
      "GET",
      "/dashboard/v1/account/sessions",
      {
        headers: { "user-agent": "Test Browser/1.0" },
      },
    );

    expect(response.statusCode).toBe(200);
    const { sessions } = response.json<{
      sessions: { id: string; current: boolean; ip: string | null }[];
    }>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.every((s) => s.ip !== null)).toBe(true);
    expect(response.body).not.toMatch(/hash|token/i);
  });

  it("ends another session, which then stops working", async () => {
    const laptop = new Browser(app);
    await laptop.login("alice@example.com");
    const { sessions } = (
      await alice.request("GET", "/dashboard/v1/account/sessions")
    ).json<{ sessions: { id: string; current: boolean }[] }>();
    const other = sessions.find((s) => !s.current)!;

    const ended = await alice.request(
      "DELETE",
      `/dashboard/v1/account/sessions/${other.id}`,
    );

    expect(ended.statusCode).toBe(204);
    expect((await laptop.request("GET", ME)).statusCode).toBe(401);
    expect((await alice.request("GET", ME)).statusCode).toBe(200);
    expect(audit.events.map((e) => e.action)).toContain("user.session_revoked");
  });

  it("someone else's session is the same 404 as a missing one", async () => {
    const other = new Browser(app);
    await other.signUp("eve@example.com", "Eve's");
    const { sessions } = (
      await other.request("GET", "/dashboard/v1/account/sessions")
    ).json<{ sessions: { id: string }[] }>();

    for (const id of [sessions[0]!.id, randomUUID()]) {
      expectError(
        await alice.request("DELETE", `/dashboard/v1/account/sessions/${id}`),
        404,
        "NOT_FOUND",
      );
    }
    expect((await other.request("GET", ME)).statusCode).toBe(200);
  });

  it("ending this browser's own session signs it out", async () => {
    const { sessions } = (
      await alice.request("GET", "/dashboard/v1/account/sessions")
    ).json<{ sessions: { id: string }[] }>();

    const ended = await alice.request(
      "DELETE",
      `/dashboard/v1/account/sessions/${sessions[0]!.id}`,
    );

    expect(ended.statusCode).toBe(204);
    expect(alice.lastSetCookies.some((c) => c.startsWith(`${COOKIE}=;`))).toBe(
      true,
    );
    expect((await alice.request("GET", ME)).statusCode).toBe(401);
  });
});

describe("new workspaces", () => {
  it("creates one with the user as owner, recorded strictly", async () => {
    const created = await alice.request("POST", "/dashboard/v1/workspaces", {
      body: { name: " Side project " },
    });

    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect(created.json()).toMatchObject({
      name: "Side project",
      role: "owner",
    });
    expect((await alice.request("GET", ME)).json()).toMatchObject({
      workspaces: [{ id: workspace }, { id, role: "owner" }],
    });
    expect((await alice.request("GET", alice.ws(id))).statusCode).toBe(200);
    expect(audit.events.at(-1)).toMatchObject({
      action: "tenant.created",
      tenantId: id,
      resourceId: id,
      actorType: "user",
    });
  });

  it("refuses a blank name and more than the maximum", async () => {
    expectError(
      await alice.request("POST", "/dashboard/v1/workspaces", {
        body: { name: "   " },
      }),
      400,
      "BAD_REQUEST",
    );
    for (let i = 1; i < MAX_OWNED_WORKSPACES; i++) {
      const response = await alice.request("POST", "/dashboard/v1/workspaces", {
        body: { name: `W${i}` },
      });
      expect(response.statusCode).toBe(201);
    }
    expectError(
      await alice.request("POST", "/dashboard/v1/workspaces", {
        body: { name: "One too many" },
      }),
      409,
      "CONFLICT",
    );
  });

  it("isn't created if it can't be recorded", async () => {
    audit.down = true;
    const response = await alice.request("POST", "/dashboard/v1/workspaces", {
      body: { name: "Unrecorded" },
    });
    expect(response.statusCode).toBe(503);
    audit.down = false;
    const me = (await alice.request("GET", ME)).json<{
      workspaces: unknown[];
    }>();
    expect(me.workspaces).toHaveLength(1);
  });
});

describe("leaving a workspace", () => {
  it("a member leaves; the workspace is then a 404 for them", async () => {
    const member = await bob("member");

    const left = await member.request(
      "DELETE",
      member.ws(workspace, "/membership"),
    );

    expect(left.statusCode).toBe(204);
    expectError(
      await member.request("GET", member.ws(workspace)),
      404,
      "NOT_FOUND",
    );
    expect(audit.events.at(-1)).toMatchObject({
      action: "membership.removed",
      tenantId: workspace,
    });
  });

  it("the only owner can't leave; one of two owners can", async () => {
    expectError(
      await alice.request("DELETE", alice.ws(workspace, "/membership")),
      409,
      "CONFLICT",
    );
    await bob("owner");
    expect(
      (await alice.request("DELETE", alice.ws(workspace, "/membership")))
        .statusCode,
    ).toBe(204);
  });
});

describe("deleting the account", () => {
  const remove = (browser: Browser, password = PASSWORD) =>
    browser.request("POST", "/dashboard/v1/account/delete", {
      body: { password },
    });

  it("needs the right password", async () => {
    expectError(await remove(alice, "not-the-password"), 401, "UNAUTHORIZED");
    expect((await alice.request("GET", ME)).statusCode).toBe(200);
  });

  it("is refused while the user is a workspace's only owner", async () => {
    const response = await remove(alice);
    expectError(response, 409, "CONFLICT");
    expect(
      response.json<{ error: { message: string } }>().error.message,
    ).toContain("Alice's");
  });

  it("deletes the user, ends their sessions and keeps the workspaces", async () => {
    const member = await bob("member");
    const bobsWorkspace = (await member.request("GET", ME))
      .json<{ workspaces: { id: string; name: string }[] }>()
      .workspaces.find((w) => w.name === "Bob's")!.id;
    await insertMembership(db, {
      userId: await userId(alice),
      tenantId: bobsWorkspace,
      role: "owner",
    });
    const before = audit.events.length;

    const response = await remove(member);

    expect(response.statusCode).toBe(204);
    expect((await member.request("GET", ME)).statusCode).toBe(401);
    expect((await member.login("bob@example.com")).statusCode).toBe(401);
    expect(
      audit.events
        .slice(before)
        .filter((e) => e.action === "user.deleted")
        .map((e) => e.tenantId)
        .sort(),
    ).toEqual([workspace, bobsWorkspace].sort());
    expect(
      (await alice.request("GET", alice.ws(bobsWorkspace))).statusCode,
    ).toBe(200);
  });
});
