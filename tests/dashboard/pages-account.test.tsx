import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuditPage from "@/app/workspaces/[workspaceId]/audit/page";
import SettingsPage from "@/app/workspaces/[workspaceId]/settings/page";
import UserLogsPage from "@/app/workspaces/[workspaceId]/user-logs/page";
import WorkspacePicker from "@/app/workspaces/page";
import {
  OTHER_SESSION,
  OTHER_WS,
  POOL,
  SESSION,
  WS,
  apiError,
  me,
} from "./fake-gateway";
import { nav } from "./navigation-mock";
import { renderInWorkspace, renderPlain, setUpPageTests } from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();
const top = () => within(screen.getAllByRole("dialog").at(-1)!);

describe("audit log", () => {
  it("filters by action, outcome, resource and dates, pages and shows details", async () => {
    await renderInWorkspace(gateway(), <AuditPage />, { path: "/audit" });
    expect(
      await screen.findByText("secret.rotated", { selector: "code" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Action/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "secret.rotated" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "secret.created" }));
    expect(screen.getByText("2 chosen")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "secret.created" }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /Outcome/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "denied" }));
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: /Resource/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "secret" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear resource" }));
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-11-20T10:00" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "not a date" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      const query = gateway().called("GET", "/audit-events").at(-1)!.query;
      expect(query.getAll("action")).toEqual(["secret.rotated"]);
      expect(query.getAll("outcome")).toEqual(["denied"]);
      expect(query.get("from")).toBe(
        new Date("2026-11-20T10:00").toISOString(),
      );
      expect(query.get("to")).toBeNull();
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Details of secret.created" }),
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Details of secret.rotated" }),
    );
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Details of secret.rotated" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(
        gateway().called("GET", "/audit-events").at(-1)!.query.get("cursor"),
      ).toBe("next-page"),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Previous page" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  });

  it("says when nothing matches, and shows a load error", async () => {
    gateway().ws("GET", "/audit-events", () => ({
      status: 200,
      body: { events: [], nextCursor: null },
    }));
    await renderInWorkspace(gateway(), <AuditPage />, { path: "/audit" });
    expect(
      await screen.findByText(/No events match these filters/),
    ).toBeTruthy();
  });

  it("shows a load error", async () => {
    gateway().fail("GET", "/audit-events");
    await renderInWorkspace(gateway(), <AuditPage />, { path: "/audit" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("user activity", () => {
  it("asks for a pool, then shows its log", async () => {
    await renderInWorkspace(gateway(), <UserLogsPage />, {
      path: "/user-logs",
    });
    expect(
      await screen.findByText("Choose a user pool to see its log."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("User pool"), {
      target: { value: POOL },
    });
    expect(nav.router.replace).toHaveBeenCalledWith(
      `/workspaces/${WS}/user-logs?pool=${POOL}`,
    );
    fireEvent.change(screen.getByLabelText("User pool"), {
      target: { value: "" },
    });
    expect(nav.router.replace).toHaveBeenLastCalledWith(
      `/workspaces/${WS}/user-logs`,
    );
  });

  it("shows the chosen pool's log", async () => {
    await renderInWorkspace(gateway(), <UserLogsPage />, {
      path: "/user-logs",
      search: `pool=${POOL}`,
    });
    expect(
      await screen.findByText("pool_user.login_failed", { selector: "code" }),
    ).toBeTruthy();
  });

  it("no pools yet, and a load error", async () => {
    gateway().ws("GET", "/user-pools", () => ({
      status: 200,
      body: { pools: [] },
    }));
    await renderInWorkspace(gateway(), <UserLogsPage />, {
      path: "/user-logs",
    });
    expect(await screen.findByText(/No user pools yet/)).toBeTruthy();
  });

  it("shows a pool load error", async () => {
    gateway().fail("GET", "/user-pools");
    await renderInWorkspace(gateway(), <UserLogsPage />, {
      path: "/user-logs",
    });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("workspace settings", () => {
  it("deletes the workspace only when its name is typed", async () => {
    await renderInWorkspace(gateway(), <SettingsPage />, { path: "/settings" });
    expect(await screen.findByText(WS)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    fireEvent.click(top().getByRole("button", { name: "Delete workspace" }));
    expect(
      top().getByText("Type the workspace's name exactly as shown."),
    ).toBeTruthy();
    fireEvent.change(top().getByLabelText(/^Workspace name/), {
      target: { value: "Acme shop" },
    });
    fireEvent.click(top().getByRole("button", { name: "Delete workspace" }));
    await waitFor(() =>
      expect(
        gateway().calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.path === `/dashboard/v1/workspaces/${WS}`,
        ),
      ).toBe(true),
    );
  });

  it("shows a refused deletion and lets you keep it", async () => {
    gateway().on("DELETE", `/dashboard/v1/workspaces/${WS}`, () =>
      apiError(503, "SECRETS_SEALED", "Unseal first"),
    );
    await renderInWorkspace(gateway(), <SettingsPage />, { path: "/settings" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete workspace" }),
    );
    fireEvent.change(top().getByLabelText(/^Workspace name/), {
      target: { value: "Acme shop" },
    });
    fireEvent.click(top().getByRole("button", { name: "Delete workspace" }));
    expect(await top().findByText("Unseal first")).toBeTruthy();
    fireEvent.click(top().getByRole("button", { name: "Keep it" }));
  });

  it("members can't delete", async () => {
    await renderInWorkspace(gateway(), <SettingsPage />, {
      path: "/settings",
      role: "member",
    });
    expect(
      await screen.findByText("Only an owner can delete the workspace."),
    ).toBeTruthy();
  });
});

describe("workspace picker", () => {
  it("lists workspaces and creates one", async () => {
    renderPlain(<WorkspacePicker />, "/workspaces");
    expect(await screen.findByText(/You belong to 2 workspaces/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    fireEvent.click(top().getByRole("button", { name: "Create workspace" }));
    expect(top().getByText("Enter a name for the workspace.")).toBeTruthy();
    fireEvent.change(top().getByLabelText(/^Workspace name/), {
      target: { value: " Team " },
    });
    fireEvent.click(top().getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(`/workspaces/${OTHER_WS}`),
    );
    expect(await screen.findByText("Workspace Team created")).toBeTruthy();
  });

  it("shows a taken name and other failures when creating", async () => {
    let answer = apiError(
      409,
      "CONFLICT",
      "You already have a workspace with that name",
    );
    gateway().on("POST", "/dashboard/v1/workspaces", () => answer);
    renderPlain(<WorkspacePicker />, "/workspaces");
    fireEvent.click(
      await screen.findByRole("button", { name: "Create workspace" }),
    );
    fireEvent.change(top().getByLabelText(/^Workspace name/), {
      target: { value: "Acme shop" },
    });
    fireEvent.click(top().getByRole("button", { name: "Create workspace" }));
    expect(
      await top().findByText("You already have a workspace with that name"),
    ).toBeTruthy();
    answer = apiError(500, "INTERNAL_ERROR", "Create broke");
    fireEvent.click(top().getByRole("button", { name: "Create workspace" }));
    expect(await top().findByText("Create broke")).toBeTruthy();
    fireEvent.click(top().getByRole("button", { name: "Cancel" }));
  });

  it("someone in no workspace, with a single one, signed out, or a failure", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () => ({
      status: 200,
      body: { ...me(), workspaces: [] },
    }));
    renderPlain(<WorkspacePicker />, "/workspaces");
    expect(await screen.findByText("No workspaces")).toBeTruthy();
  });

  it("one workspace", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () => ({
      status: 200,
      body: { ...me(), workspaces: [me().workspaces[0]] },
    }));
    renderPlain(<WorkspacePicker />, "/workspaces");
    expect(await screen.findByText(/You belong to 1 workspace\./)).toBeTruthy();
  });

  it("sends a signed out visitor to log in", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () =>
      apiError(401, "UNAUTHENTICATED", "Log in"),
    );
    renderPlain(<WorkspacePicker />, "/workspaces");
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        expect.stringContaining("/login"),
      ),
    );
  });

  it("shows a load error", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () =>
      apiError(500, "INTERNAL_ERROR", "Me broke"),
    );
    renderPlain(<WorkspacePicker />, "/workspaces");
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

async function openAccount() {
  await renderInWorkspace(gateway(), <SettingsPage />, { path: "/settings" });
  fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  return top();
}

describe("navbar", () => {
  it("switches theme, opens the workspace menu and logs out", async () => {
    await renderInWorkspace(gateway(), <SettingsPage />, { path: "/settings" });
    fireEvent.click(await screen.findByRole("button", { name: /Dark/ }));
    expect(
      screen.getByRole("button", { name: /Dark/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Light/ }));
    fireEvent.click(screen.getByRole("button", { name: /System/ }));
    const switcher = screen.getByRole("button", { name: /switch workspace/ });
    fireEvent.click(switcher);
    expect(switcher.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: /Side project/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(switcher.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(switcher);
    fireEvent.pointerDown(document.body);
    expect(switcher.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/login"),
    );
  });

  it("ends the session view when the session expires", async () => {
    await renderInWorkspace(gateway(), <SettingsPage />, { path: "/settings" });
    await screen.findByText(WS);
    gateway().on("GET", "/dashboard/v1/account/sessions", () =>
      apiError(401, "UNAUTHENTICATED", "Expired"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(top().getByRole("tab", { name: "Sessions" }));
    expect(await screen.findByText("Session ended")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Log in again" })).toBeTruthy();
  });
});

describe("account dialog", () => {
  it("moves between tabs with the arrow keys and closes", async () => {
    const dialog = await openAccount();
    const tabs = dialog.getByRole("tablist");
    fireEvent.keyDown(tabs, { key: "ArrowRight" });
    expect(
      dialog
        .getByRole("tab", { name: "Password" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tabs, { key: "ArrowLeft" });
    fireEvent.keyDown(tabs, { key: "ArrowLeft" });
    expect(
      dialog
        .getByRole("tab", { name: "Delete account" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tabs, { key: "Enter" });
    fireEvent.click(dialog.getByRole("button", { name: "Close" }));
  });

  it("saves and removes the display name, and explains refusals", async () => {
    let answer: unknown;
    gateway().on(
      "PATCH",
      "/dashboard/v1/account/profile",
      () => answer ?? { status: 200, body: me() },
    );
    const dialog = await openAccount();
    fireEvent.change(dialog.getByLabelText(/^Display name/), {
      target: { value: "x".repeat(61) },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save profile" }));
    expect(dialog.getByText("Use at most 60 characters.")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText(/^Display name/), {
      target: { value: " Ada L " },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Display name saved")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText(/^Display name/), {
      target: { value: "  " },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Display name removed")).toBeTruthy();
    answer = apiError(400, "BAD_REQUEST", "bad");
    fireEvent.click(dialog.getByRole("button", { name: "Save profile" }));
    expect(await dialog.findByText(/Use letters, digits, spaces/)).toBeTruthy();
    answer = apiError(500, "INTERNAL_ERROR", "Profile broke");
    fireEvent.click(dialog.getByRole("button", { name: "Save profile" }));
    expect(await dialog.findByText("Profile broke")).toBeTruthy();
  });

  it("changes the password after checking it", async () => {
    let answer: unknown;
    gateway().on(
      "POST",
      "/dashboard/v1/auth/change-password",
      () => answer ?? { status: 204 },
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Password" }));
    fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
    expect(dialog.getByText("Enter your current password.")).toBeTruthy();
    expect(dialog.getByText("Use at least 12 characters.")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText(/^Current password/), {
      target: { value: "same-password-1" },
    });
    fireEvent.change(dialog.getByLabelText(/^New password/), {
      target: { value: "same-password-1" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
    expect(dialog.getByText(/different from the current one/)).toBeTruthy();
    fireEvent.change(dialog.getByLabelText(/^New password/), {
      target: { value: "a-new-password-2" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Password changed/)).toBeTruthy();

    for (const [error, shown] of [
      [
        apiError(400, "BAD_REQUEST", "That password is too common"),
        "That password is too common",
      ],
      [apiError(500, "INTERNAL_ERROR", "Password broke"), "Password broke"],
    ] as const) {
      answer = error;
      fireEvent.change(dialog.getByLabelText(/^Current password/), {
        target: { value: "old-password-1" },
      });
      fireEvent.change(dialog.getByLabelText(/^New password/), {
        target: { value: "a-new-password-2" },
      });
      fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
      expect(await dialog.findByText(shown)).toBeTruthy();
    }
  });

  it("lists sessions, ends another one and logs out everywhere", async () => {
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Sessions" }));
    expect(await dialog.findByText("Chrome on Windows")).toBeTruthy();
    expect(dialog.getByText("Unknown browser")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "End session" }));
    fireEvent.click(top().getByRole("button", { name: "End session" }));
    expect(await screen.findByText("Session ended")).toBeTruthy();
    expect(gateway().calls.some((c) => c.path.endsWith(OTHER_SESSION))).toBe(
      true,
    );
    fireEvent.click(dialog.getByRole("button", { name: "Log out everywhere" }));
    fireEvent.click(top().getByRole("button", { name: "Log out everywhere" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/login"),
    );
  });

  it("ending this session logs out; failures stay in the dialog", async () => {
    let fail = true;
    gateway().on("DELETE", "/dashboard/v1/account/sessions/{*}", () =>
      fail ? apiError(500, "INTERNAL_ERROR", "End broke") : { status: 204 },
    );
    gateway().on("POST", "/dashboard/v1/auth/logout-all", () =>
      apiError(500, "INTERNAL_ERROR", "All broke"),
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Sessions" }));
    fireEvent.click(await dialog.findByRole("button", { name: "Log out" }));
    fireEvent.click(top().getByRole("button", { name: "Log out" }));
    expect(await top().findByText("End broke")).toBeTruthy();
    fail = false;
    fireEvent.click(top().getByRole("button", { name: "Log out" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/login"),
    );
    expect(gateway().calls.some((c) => c.path.endsWith(SESSION))).toBe(true);
  });

  it("shows a failed log out everywhere and a session list error", async () => {
    gateway().on("POST", "/dashboard/v1/auth/logout-all", () =>
      apiError(500, "INTERNAL_ERROR", "All broke"),
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Sessions" }));
    fireEvent.click(dialog.getByRole("button", { name: "Log out everywhere" }));
    fireEvent.click(top().getByRole("button", { name: "Log out everywhere" }));
    expect(await top().findByText("All broke")).toBeTruthy();
    fireEvent.click(top().getByRole("button", { name: "Keep it" }));
  });

  it("names other browsers and systems", async () => {
    const agents = [
      "Mozilla/5.0 (Macintosh; Mac OS X 14) Edg/140",
      "Mozilla/5.0 (Linux; Android 15) OPR/110",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18) Safari/605",
      "Mozilla/5.0 (X11; Linux x86_64) Firefox/140",
      "Mozilla/5.0 (Macintosh; Mac OS X 14) Safari/605",
      "curl/8.0",
    ];
    gateway().on("GET", "/dashboard/v1/account/sessions", () => ({
      status: 200,
      body: {
        sessions: agents.map((userAgent, i) => ({
          id: `0000000${i}-0000-4000-8000-000000000000`,
          createdAt: "2026-11-20T10:00:00.000Z",
          lastUsedAt: "2026-11-20T10:00:00.000Z",
          expiresAt: "2026-12-20T10:00:00.000Z",
          ip: "198.51.100.1",
          userAgent,
          current: false,
        })),
      },
    }));
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Sessions" }));
    for (const name of [
      "Edge on macOS",
      "Opera on Android",
      "Safari on iOS",
      "Firefox on Linux",
      "Safari on macOS",
      "A browser",
    ]) {
      expect(await dialog.findByText(name)).toBeTruthy();
    }
  });

  it("shows a session list error", async () => {
    gateway().on("GET", "/dashboard/v1/account/sessions", () =>
      apiError(500, "INTERNAL_ERROR", "List broke"),
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Sessions" }));
    expect(
      await dialog.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });

  it("leaves a workspace, and shows a refusal", async () => {
    let answer: unknown = apiError(409, "CONFLICT", "You are the only owner");
    gateway().ws("DELETE", "/membership", () => answer);
    gateway().on(
      "DELETE",
      `/dashboard/v1/workspaces/${OTHER_WS}/membership`,
      () => ({ status: 204 }),
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Workspaces" }));
    fireEvent.click(dialog.getAllByRole("button", { name: "Leave" })[0]!);
    fireEvent.click(top().getByRole("button", { name: "Leave workspace" }));
    expect(await top().findByText("You are the only owner")).toBeTruthy();
    fireEvent.click(top().getByRole("button", { name: "Keep it" }));
    fireEvent.click(dialog.getAllByRole("button", { name: "Leave" })[1]!);
    fireEvent.click(top().getByRole("button", { name: "Leave workspace" }));
    expect(await screen.findByText("You left Side project")).toBeTruthy();
    answer = undefined;
  });

  it("deletes the account with a password, and explains refusals", async () => {
    let answer: unknown;
    gateway().on(
      "POST",
      "/dashboard/v1/account/delete",
      () => answer ?? { status: 204 },
    );
    const dialog = await openAccount();
    fireEvent.click(dialog.getByRole("tab", { name: "Delete account" }));
    fireEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    fireEvent.click(top().getByRole("button", { name: "Delete account" }));
    expect(
      top().getByText("Enter your password to confirm.", {
        selector: ".field-error",
      }),
    ).toBeTruthy();
    for (const [error, shown] of [
      [
        apiError(409, "CONFLICT", "You are the only owner of Acme shop"),
        "You are the only owner of Acme shop",
      ],
      [apiError(500, "INTERNAL_ERROR", "Delete broke"), "Delete broke"],
    ] as const) {
      answer = error;
      fireEvent.change(top().getByLabelText(/^Password/), {
        target: { value: "my-password-1" },
      });
      fireEvent.click(top().getByRole("button", { name: "Delete account" }));
      expect(await top().findByText(shown)).toBeTruthy();
    }
    answer = undefined;
    fireEvent.click(top().getByRole("button", { name: "Delete account" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/login"),
    );
  });

  it("an account without a password confirms with its email", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () => ({
      status: 200,
      body: {
        ...me(),
        user: { ...me().user, displayName: null, hasPassword: false },
        workspaces: [],
      },
    }));
    gateway().on("POST", "/dashboard/v1/account/delete", () =>
      apiError(400, "BAD_REQUEST", "x"),
    );
    renderPlain(<WorkspacePicker />, "/workspaces");
    fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByRole("tab", { name: "Profile" })).toBeTruthy();
    expect(dialog.queryByRole("tab", { name: "Password" })).toBeNull();
    fireEvent.click(dialog.getByRole("tab", { name: "Workspaces" }));
    expect(await dialog.findByText(/You aren't in any workspace/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("tab", { name: "Delete account" }));
    fireEvent.click(
      await dialog.findByRole("button", { name: "Delete account" }),
    );
    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBe(2));
    fireEvent.click(top().getByRole("button", { name: "Delete account" }));
    expect(
      await top().findByText("Type your email address to confirm."),
    ).toBeTruthy();
    fireEvent.change(top().getByLabelText(/^Email/), {
      target: { value: "wrong@example.com" },
    });
    fireEvent.click(top().getByRole("button", { name: "Delete account" }));
    expect(
      await top().findByText("That isn't your email address."),
    ).toBeTruthy();
    fireEvent.click(top().getByRole("button", { name: "Keep it" }));
  });
});
