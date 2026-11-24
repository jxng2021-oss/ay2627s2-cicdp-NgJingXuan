import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserPicker } from "@/components/user-picker";
import type { Me, Overview } from "@/lib/api/client";
import { WorkspaceContext } from "@/lib/workspace";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const POOL = "22222222-2222-4222-8222-222222222222";
const ADA = "33333333-3333-4333-8333-333333333333";
const BOB = "44444444-4444-4444-8444-444444444444";

const user = (id: string, email: string) => ({
  id,
  email,
  status: "active",
  attributes: {},
  roles: [],
  lockedUntil: null,
  passwordResetRequired: false,
  createdAt: "2026-11-20T10:00:00.000Z",
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function gateway() {
  const fetch = vi.fn((url: string) => {
    if (url.endsWith("/user-pools")) {
      return json({
        pools: [{ id: POOL, name: "Shop customers", userCount: 2 }],
      });
    }
    if (url.includes(`/users/${BOB}`))
      return json(user(BOB, "bob@example.com"));
    if (url.includes("/users/")) {
      return json(
        { error: { code: "NOT_FOUND", message: "No user", requestId: "r" } },
        404,
      );
    }
    if (url.includes("email=nobody"))
      return json({ users: [], nextCursor: null });
    return json({
      users: [user(ADA, "ada@example.com"), user(BOB, "bob@example.com")],
      nextCursor: null,
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function open(by: "id" | "email", chosen: string[] = []) {
  const onAdd = vi.fn();
  render(
    <WorkspaceContext.Provider
      value={{
        id: WORKSPACE,
        me: {} as Me,
        overview: {} as Overview,
        isOwner: true,
        sealed: false,
        refresh: () => undefined,
      }}
    >
      <UserPicker by={by} chosen={chosen} onAdd={onAdd} onClose={vi.fn()} />
    </WorkspaceContext.Provider>,
  );
  return onAdd;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UserPicker", () => {
  it("lists a pool's users, and adds the ticked ones by email", async () => {
    gateway();
    const onAdd = open("email");

    fireEvent.click(
      await screen.findByRole("checkbox", { name: /ada@example.com/ }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add 1 user" }));
    expect(onAdd).toHaveBeenCalledWith([
      { by: "email", id: ADA, email: "ada@example.com" },
    ]);
  });

  it("users already chosen can't be ticked again", async () => {
    gateway();
    open("email", ["email:ada@example.com"]);

    const ada = await screen.findByRole("checkbox", {
      name: /ada@example.com/,
    });
    expect((ada as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/already chosen/)).toBeTruthy();
  });

  it("by ID: a pasted ID finds exactly that user; an unknown one says so", async () => {
    const fetch = gateway();
    const onAdd = open("id");
    await screen.findByRole("checkbox", { name: /ada@example.com/ });

    const search = screen.getByLabelText("Search by email, or paste a user ID");
    fireEvent.change(search, { target: { value: BOB } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("checkbox", { name: /ada@example.com/ }),
      ).toBeNull(),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/user-pools/${POOL}/users/${BOB}`),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /bob@example.com/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 user" }));
    expect(onAdd).toHaveBeenCalledWith([
      { by: "id", id: BOB, email: "bob@example.com" },
    ]);

    fireEvent.change(search, {
      target: { value: "55555555-5555-4555-8555-555555555555" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText(/No user in Shop customers matches/),
    ).toBeTruthy();
  });

  it("an email search with no match says so", async () => {
    gateway();
    open("email");
    await screen.findByRole("checkbox", { name: /ada@example.com/ });

    fireEvent.change(screen.getByLabelText("Search by email"), {
      target: { value: "nobody" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText('No user in Shop customers matches "nobody".'),
    ).toBeTruthy();
  });
});
