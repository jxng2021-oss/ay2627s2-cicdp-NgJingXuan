import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UserPoolPage from "@/app/workspaces/[workspaceId]/user-pools/[poolId]/page";
import PoolUserPage from "@/app/workspaces/[workspaceId]/user-pools/[poolId]/users/[userId]/page";
import UserPoolsPage from "@/app/workspaces/[workspaceId]/user-pools/page";
import { ADA, BOB, POOL, WS, apiError, poolUser } from "./fake-gateway";
import { nav } from "./navigation-mock";
import { renderInWorkspace, setUpPageTests } from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();
const dialog = () => within(screen.getByRole("dialog"));
const typeIn = (
  scope: ReturnType<typeof dialog>,
  label: RegExp,
  value: string,
) => fireEvent.change(scope.getByLabelText(label), { target: { value } });

describe("user pools list", () => {
  it("lists pools and creates one after checking the settings", async () => {
    await renderInWorkspace(gateway(), <UserPoolsPage />, {
      path: "/user-pools",
    });
    expect(
      await screen.findByRole("link", { name: "Shop customers" }),
    ).toBeTruthy();
    expect(screen.getByText("15 min")).toBeTruthy();
    expect(screen.getByText("30 days")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create user pool" }));
    typeIn(dialog(), /^Name/, " ");
    typeIn(dialog(), /^Access token lifetime/, "0");
    typeIn(dialog(), /^Session lifetime/, "91");
    typeIn(dialog(), /^Minimum password length/, "8");
    fireEvent.click(dialog().getByRole("button", { name: "Create user pool" }));
    expect(dialog().getByText(/Use 1 to 64 letters/)).toBeTruthy();
    expect(dialog().getByText("Between 1 and 1,440 minutes.")).toBeTruthy();
    expect(dialog().getByText("Between 1 and 90 days.")).toBeTruthy();
    expect(dialog().getByText("Between 12 and 64 characters.")).toBeTruthy();

    typeIn(dialog(), /^Name/, "Staff");
    typeIn(dialog(), /^Access token lifetime/, "10");
    typeIn(dialog(), /^Session lifetime/, "7");
    typeIn(dialog(), /^Minimum password length/, "14");
    fireEvent.click(dialog().getByRole("button", { name: "Create user pool" }));
    expect(await screen.findByText("User pool Staff created")).toBeTruthy();
    expect(gateway().called("POST", "/user-pools")[0]?.body).toEqual({
      name: "Staff",
      accessTokenTtlSeconds: 600,
      refreshTokenTtlSeconds: 604_800,
      minPasswordLength: 14,
    });
  });

  it("says when the name is taken, and shows other failures", async () => {
    let answer = apiError(409, "CONFLICT", "exists");
    gateway().ws("POST", "/user-pools", () => answer);
    await renderInWorkspace(gateway(), <UserPoolsPage />, {
      path: "/user-pools",
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create user pool" }),
    );
    typeIn(dialog(), /^Name/, "Shop customers");
    fireEvent.click(dialog().getByRole("button", { name: "Create user pool" }));
    expect(
      await dialog().findByText("A pool with this name already exists."),
    ).toBeTruthy();
    answer = apiError(500, "INTERNAL_ERROR", "Pool broke");
    fireEvent.click(dialog().getByRole("button", { name: "Create user pool" }));
    expect(await dialog().findByText("Pool broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
  });

  it("members see an empty list without a create button", async () => {
    gateway().ws("GET", "/user-pools", () => ({
      status: 200,
      body: { pools: [] },
    }));
    await renderInWorkspace(gateway(), <UserPoolsPage />, {
      path: "/user-pools",
      role: "member",
    });
    expect(await screen.findByText(/An owner can create one/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create user pool" }),
    ).toBeNull();
  });

  it("owners see an empty list with a hint", async () => {
    gateway().ws("GET", "/user-pools", () => ({
      status: 200,
      body: { pools: [] },
    }));
    await renderInWorkspace(gateway(), <UserPoolsPage />, {
      path: "/user-pools",
    });
    expect(await screen.findByText(/Create one for each app/)).toBeTruthy();
  });

  it("shows a load error", async () => {
    gateway().fail("GET", "/user-pools");
    await renderInWorkspace(gateway(), <UserPoolsPage />, {
      path: "/user-pools",
    });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("a user pool's page", () => {
  const open = (role: "owner" | "member" = "owner") =>
    renderInWorkspace(gateway(), <UserPoolPage />, {
      path: `/user-pools/${POOL}`,
      params: { poolId: POOL },
      role,
    });

  it("shows how to connect, the users, search and paging", async () => {
    await open();
    expect(
      await screen.findByText(/2 users\. Access tokens last 15 minutes/),
    ).toBeTruthy();
    expect(await screen.findByText("bob@example.com")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy the code" }));

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(
        gateway()
          .called("GET", `/user-pools/${POOL}/users`)
          .at(-1)
          ?.query.get("cursor"),
      ).toBe("next-page"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "First page" }));

    gateway().ws("GET", "/user-pools/{*}/users", () => ({
      status: 200,
      body: { users: [], nextCursor: null },
    }));
    fireEvent.change(screen.getByLabelText(/^Find by email/), {
      target: { value: " nobody " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText("No user's email contains that."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Find by email/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/No users yet/)).toBeTruthy();
  });

  it("deletes the pool after confirming, and shows a failure", async () => {
    let answer: unknown = { status: 204 };
    gateway().ws("DELETE", "/user-pools/{*}", () => answer);
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete user pool" }),
    );
    answer = apiError(500, "INTERNAL_ERROR", "Delete broke");
    fireEvent.click(dialog().getByRole("button", { name: "Delete user pool" }));
    expect(await dialog().findByText("Delete broke")).toBeTruthy();
    answer = { status: 204 };
    fireEvent.click(dialog().getByRole("button", { name: "Delete user pool" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        `/workspaces/${WS}/user-pools`,
      ),
    );
  });

  it("manages roles: create, edit, check and delete", async () => {
    await open();
    expect(await screen.findByText("Can edit products")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    typeIn(dialog(), /^Name/, "Bad Role");
    typeIn(dialog(), /^Permissions/, "orders:refund\nnot a permission");
    fireEvent.click(dialog().getByRole("button", { name: "Create role" }));
    expect(dialog().getByText(/Use 1 to 64 lowercase letters/)).toBeTruthy();
    expect(
      dialog().getByText(/"not a permission" isn't a permission/),
    ).toBeTruthy();
    typeIn(
      dialog(),
      /^Permissions/,
      Array.from({ length: 101 }, (_, i) => `p${i}`).join(","),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Create role" }));
    expect(dialog().getByText("Use at most 100 permissions.")).toBeTruthy();
    typeIn(dialog(), /^Name/, "support");
    typeIn(dialog(), /^Description/, " Helps customers ");
    typeIn(dialog(), /^Permissions/, "orders:read, orders:refund\norders:read");
    fireEvent.click(dialog().getByRole("button", { name: "Create role" }));
    expect(await screen.findByText("Role support created")).toBeTruthy();
    expect(
      gateway().called("POST", `/user-pools/${POOL}/roles`)[0]?.body,
    ).toEqual({
      name: "support",
      description: "Helps customers",
      permissions: ["orders:read", "orders:refund"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit role editor" }));
    typeIn(dialog(), /^Permissions/, "*");
    fireEvent.click(dialog().getByRole("button", { name: "Save role" }));
    expect(await screen.findByText("Role editor saved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete role viewer" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete role" }));
    expect(await screen.findByText("Role viewer deleted")).toBeTruthy();
  });

  it("shows role conflicts and failures", async () => {
    let answer = apiError(409, "CONFLICT", "A role with this name exists");
    gateway().ws("POST", "/user-pools/{*}/roles", () => answer);
    gateway().fail(
      "DELETE",
      "/user-pools/{*}/roles/{*}",
      500,
      "INTERNAL_ERROR",
      "Role delete broke",
    );
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Create role" }));
    typeIn(dialog(), /^Name/, "editor");
    fireEvent.click(dialog().getByRole("button", { name: "Create role" }));
    expect(
      await dialog().findByText("A role with this name exists"),
    ).toBeTruthy();
    answer = apiError(500, "INTERNAL_ERROR", "Role broke");
    fireEvent.click(dialog().getByRole("button", { name: "Create role" }));
    expect(await dialog().findByText("Role broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete role editor" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete role" }));
    expect(await dialog().findByText("Role delete broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("members can only view, and see when there are no roles", async () => {
    gateway().ws("GET", "/user-pools/{*}/roles", () => ({
      status: 200,
      body: { roles: [] },
    }));
    gateway().ws("GET", "/user-pools/{*}", () => ({
      status: 200,
      body: {
        id: POOL,
        name: "Tiny",
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 86_400,
        minPasswordLength: 12,
        userCount: 1,
        issuer: "iss",
        jwksUrl: "jwks",
        createdAt: "2026-11-20T10:00:00.000Z",
      },
    }));
    await open("member");
    expect(await screen.findByText(/1 user\. /)).toBeTruthy();
    expect(
      await screen.findByText(/No roles yet\. An owner can create one/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only workspace owners can manage users or delete/),
    ).toBeTruthy();
  });

  it("an owner with no roles yet gets a hint", async () => {
    gateway().ws("GET", "/user-pools/{*}/roles", () => ({
      status: 200,
      body: { roles: [] },
    }));
    await open();
    expect(
      await screen.findByText(/Create one, then give it to users/),
    ).toBeTruthy();
  });

  it("a missing pool, and load errors", async () => {
    gateway().fail("GET", "/user-pools/{*}", 404, "NOT_FOUND", "No pool");
    await open();
    expect(
      await screen.findByText(/This user pool doesn.t exist/),
    ).toBeTruthy();
  });

  it("shows pool, user and role load errors", async () => {
    gateway().fail("GET", "/user-pools/{*}/users");
    gateway().fail("GET", "/user-pools/{*}/roles");
    await open();
    expect(
      (await screen.findAllByRole("button", { name: "Retry request" })).length,
    ).toBe(2);
  });

  it("shows a pool load error", async () => {
    gateway().fail("GET", "/user-pools/{*}");
    await open();
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("a pool user's page", () => {
  const open = (userId = BOB, role: "owner" | "member" = "owner") =>
    renderInWorkspace(gateway(), <PoolUserPage />, {
      path: `/user-pools/${POOL}/users/${userId}`,
      params: { poolId: POOL, userId },
      role,
    });

  it("shows details and roles, gives and takes a role", async () => {
    await open();
    expect(await screen.findByText("plan = pro")).toBeTruthy();
    expect(await screen.findByText("products:read")).toBeTruthy();
    const select = await screen.findByLabelText("Give a role");
    fireEvent.change(select, { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Give role" }));
    expect(
      await screen.findByText("bob@example.com now has the viewer role"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Take the editor role" }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Take role" }));
    expect(
      await screen.findByText("Role editor taken from bob@example.com"),
    ).toBeTruthy();
  });

  it("shows failures to give and take roles", async () => {
    gateway().fail(
      "PUT",
      "/user-pools/{*}/users/{*}/roles/{*}",
      500,
      "INTERNAL_ERROR",
      "Give broke",
    );
    gateway().fail(
      "DELETE",
      "/user-pools/{*}/users/{*}/roles/{*}",
      500,
      "INTERNAL_ERROR",
      "Take broke",
    );
    await open();
    fireEvent.change(await screen.findByLabelText("Give a role"), {
      target: { value: "viewer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Give role" }));
    expect(await screen.findByText("Give broke")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Take the editor role" }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Take role" }));
    expect(await dialog().findByText("Take broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("disables, resets and deletes an active user", async () => {
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Disable user" }),
    );
    fireEvent.click(dialog().getByRole("button", { name: "Disable user" }));
    expect(await screen.findByText("bob@example.com disabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    fireEvent.click(dialog().getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText(/must choose a new password/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete user" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete user" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        `/workspaces/${WS}/user-pools/${POOL}`,
      ),
    );
  });

  it("enables and unlocks a disabled, locked user with no roles", async () => {
    gateway().ws("GET", "/user-pools/{*}/roles", () => ({
      status: 200,
      body: { roles: [] },
    }));
    await open(ADA);
    expect(await screen.findByText("No roles.")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(
      await screen.findByRole("option", {
        name: /Create a role on the pool's page first/,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable user" }));
    fireEvent.click(dialog().getByRole("button", { name: "Enable user" }));
    expect(await screen.findByText("ada@example.com enabled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlock user" }));
    fireEvent.click(dialog().getByRole("button", { name: "Unlock user" }));
    expect(await screen.findByText("ada@example.com unlocked")).toBeTruthy();
  });

  it("a user with every role, a pending reset, and a failed action", async () => {
    gateway().ws("GET", "/user-pools/{*}/users/{*}", () => ({
      status: 200,
      body: poolUser(BOB, "bob@example.com", {
        roles: ["editor", "viewer"],
        passwordResetRequired: true,
      }),
    }));
    gateway().fail(
      "PATCH",
      "/user-pools/{*}/users/{*}",
      500,
      "INTERNAL_ERROR",
      "Status broke",
    );
    await open();
    expect(
      await screen.findByRole("option", { name: "The user has every role" }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Password reset pending",
      }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Disable user" }));
    fireEvent.click(dialog().getByRole("button", { name: "Disable user" }));
    expect(await dialog().findByText("Status broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("members only view", async () => {
    await open(BOB, "member");
    expect(
      await screen.findByText("Only workspace owners can manage users."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Take the editor role" }),
    ).toBeNull();
  });

  it("a missing user", async () => {
    gateway().fail(
      "GET",
      "/user-pools/{*}/users/{*}",
      404,
      "NOT_FOUND",
      "No user",
    );
    await open();
    expect(await screen.findByText(/This user doesn.t exist/)).toBeTruthy();
  });

  it("a user load error", async () => {
    gateway().fail("GET", "/user-pools/{*}/users/{*}");
    await open();
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});
