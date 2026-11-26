import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import FlagPage from "@/app/workspaces/[workspaceId]/flags/[key]/page";
import FlagsPage from "@/app/workspaces/[workspaceId]/flags/page";
import { BOB, WS, apiError, flag, stringFlag } from "./fake-gateway";
import { nav } from "./navigation-mock";
import { renderInWorkspace, setUpPageTests } from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();
const dialog = () => within(screen.getByRole("dialog"));

const targeted = () => {
  const base = flag();
  return {
    ...base,
    environments: {
      ...base.environments,
      production: {
        enabled: true,
        rules: [
          {
            conditions: [
              {
                attribute: "email",
                operator: "in",
                values: ["ada@example.com", "c@x.io", "d@x.io", "e@x.io"],
              },
            ],
            value: true,
            percentage: 50,
          },
          {
            conditions: [
              { attribute: "key", operator: "equals", values: [BOB] },
            ],
            value: false,
          },
        ],
        defaultValue: false,
      },
    },
  };
};

describe("feature flags list", () => {
  it("shows each environment's state and creates a switch flag", async () => {
    const base = flag("everyone");
    gateway().ws("GET", "/flags", () => ({
      status: 200,
      body: {
        flags: [
          flag(),
          stringFlag(),
          {
            ...base,
            description: "",
            environments: {
              ...base.environments,
              staging: { enabled: true, rules: [], defaultValue: false },
            },
          },
        ],
      },
    }));
    await renderInWorkspace(gateway(), <FlagsPage />, { path: "/flags" });
    expect(await screen.findByText("The new checkout flow")).toBeTruthy();
    expect(screen.getAllByText("On for some").length).toBeGreaterThan(0);
    expect(screen.getAllByText("On for everyone").length).toBeGreaterThan(0);
    expect(screen.getByText("On, nobody gets true")).toBeTruthy();
    expect(screen.getAllByText("Off").length).toBeGreaterThan(0);
    expect(screen.getByText("Text")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create flag" }));
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "Bad Key" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create flag" }));
    expect(dialog().getByText(/Use 1 to 64 lowercase letters/)).toBeTruthy();
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "dark-mode" },
    });
    fireEvent.change(dialog().getByLabelText(/^Description/), {
      target: { value: " Dark theme " },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create flag" }));
    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(
        `/workspaces/${WS}/flags/dark-mode`,
      ),
    );
    expect(gateway().called("POST", "/flags")[0]?.body).toEqual({
      key: "dark-mode",
      description: "Dark theme",
      kind: "boolean",
      offValue: false,
    });
  });

  it("creates a text flag, and explains a taken name or another failure", async () => {
    let answer: unknown = apiError(409, "CONFLICT", "exists");
    gateway().ws("POST", "/flags", () => answer);
    await renderInWorkspace(gateway(), <FlagsPage />, { path: "/flags" });
    fireEvent.click(await screen.findByRole("button", { name: "Create flag" }));
    fireEvent.click(dialog().getByRole("radio", { name: /Text/ }));
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "banner" },
    });
    fireEvent.change(dialog().getByLabelText(/^Value while off/), {
      target: { value: "control" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create flag" }));
    expect(
      await dialog().findByText("A flag with this name already exists."),
    ).toBeTruthy();
    expect(gateway().called("POST", "/flags")[0]?.body).toMatchObject({
      kind: "string",
      offValue: "control",
    });
    answer = apiError(500, "INTERNAL_ERROR", "Flag broke");
    fireEvent.click(dialog().getByRole("radio", { name: /On\/off switch/ }));
    fireEvent.click(dialog().getByRole("button", { name: "Create flag" }));
    expect(await dialog().findByText("Flag broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
  });

  it("members see an empty list", async () => {
    gateway().ws("GET", "/flags", () => ({ status: 200, body: { flags: [] } }));
    await renderInWorkspace(gateway(), <FlagsPage />, {
      path: "/flags",
      role: "member",
    });
    expect(await screen.findByText(/An owner can create one/)).toBeTruthy();
    expect(screen.getByText("Viewing as a member")).toBeTruthy();
  });

  it("owners see an empty list with a hint", async () => {
    gateway().ws("GET", "/flags", () => ({ status: 200, body: { flags: [] } }));
    await renderInWorkspace(gateway(), <FlagsPage />, { path: "/flags" });
    expect(
      await screen.findByText(/Create one to ship a feature/),
    ).toBeTruthy();
  });

  it("shows a load error", async () => {
    gateway().fail("GET", "/flags");
    await renderInWorkspace(gateway(), <FlagsPage />, { path: "/flags" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("a feature flag's page", () => {
  const open = (key = "new-checkout", role: "owner" | "member" = "owner") =>
    renderInWorkspace(gateway(), <FlagPage />, {
      path: `/flags/${key}`,
      params: { key },
      role,
    });

  it("reads chosen users in plain words, edits and saves them", async () => {
    gateway().ws("GET", "/flags/{*}", () => ({
      status: 200,
      body: targeted(),
    }));
    await open();
    expect(
      await screen.findByText(
        /50% of ada@example.com, c@x.io, d@x.io and 1 more can see it/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(`${BOB} can't see it.`)).toBeTruthy();
    expect(screen.getByText("Everyone else can't see it.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^How many of them can see it/), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save production" }));
    expect(screen.getByText("The percentage must be 0 to 100.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^How many of them can see it/), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("What c@x.io gets"), {
      target: { value: "false" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove d@x.io" }));
    fireEvent.change(screen.getByLabelText("Everyone else"), {
      target: { value: "true" },
    });
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save production" }));
    expect(
      await screen.findByText("new-checkout saved in production"),
    ).toBeTruthy();
    const saved = gateway().called(
      "PUT",
      "/flags/new-checkout/environments/production",
    )[0]!;
    expect(saved.body).toEqual({
      enabled: true,
      defaultValue: true,
      rules: [
        {
          conditions: [
            { attribute: "email", operator: "in", values: ["c@x.io"] },
          ],
          value: false,
        },
        {
          conditions: [{ attribute: "key", operator: "in", values: [BOB] }],
          value: false,
        },
        {
          conditions: [
            {
              attribute: "email",
              operator: "in",
              values: ["ada@example.com", "e@x.io"],
            },
          ],
          value: true,
        },
      ],
    });
  });

  it("adds users from the picker, switches environment and turns it off", async () => {
    await open();
    expect(await screen.findByText("Nobody chosen yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add users by email" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /bob@example.com/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 user" }));
    expect(await screen.findByText("bob@example.com can see it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add users by ID" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /bob@example.com/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 user" }));
    expect(await screen.findByText("User ID", { selector: "td" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^How many of them can see it/), {
      target: { value: "30" },
    });
    expect(
      screen.getByText(/30% of bob@example.com, bob@example.com can see it/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    expect(
      screen.getByText("Production is off: every user can't see it."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save production" }));
    expect(
      await screen.findByText("new-checkout saved in production"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Development/ }));
    expect(
      await screen.findByText("This flag has older settings"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Staging/ }));
    expect(
      await screen.findByRole("button", { name: "Save staging" }),
    ).toBeTruthy();
  });

  it("checks what a user gets, for each reason", async () => {
    const reasons = ["rule", "off", "rollout", "default"];
    let index = 0;
    gateway().ws("POST", "/flags/evaluate", () => ({
      status: 200,
      body: {
        environment: "production",
        flags: {
          "new-checkout": {
            value: index % 2 === 0,
            reason: reasons[index++ % 4],
          },
        },
      },
    }));
    await open();
    fireEvent.change(await screen.findByLabelText(/^User ID/), {
      target: { value: ` ${BOB} ` },
    });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: " bob@example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(
      await screen.findByText(/they are one of the chosen users/),
    ).toBeTruthy();
    expect(gateway().called("POST", "/flags/evaluate")[0]?.body).toEqual({
      environment: "production",
      context: { key: BOB, attributes: { email: "bob@example.com" } },
      keys: ["new-checkout"],
    });
    fireEvent.change(screen.getByLabelText(/^User ID/), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(
      await screen.findByText(/the flag is off in production/),
    ).toBeTruthy();
    expect(gateway().called("POST", "/flags/evaluate")[1]?.body).toMatchObject({
      context: { key: "anonymous", attributes: {} },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(
      await screen.findByText(/in the share of everyone else/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/they aren't a chosen user/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy the code" }));
  });

  it("shows check, save and delete failures, then deletes", async () => {
    gateway().fail(
      "POST",
      "/flags/evaluate",
      500,
      "INTERNAL_ERROR",
      "Check broke",
    );
    gateway().fail(
      "PUT",
      "/flags/{*}/environments/{*}",
      500,
      "INTERNAL_ERROR",
      "Save broke",
    );
    let answer: unknown = apiError(500, "INTERNAL_ERROR", "Delete broke");
    gateway().ws("DELETE", "/flags/{*}", () => answer);
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("Check broke")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save production" }));
    expect(await screen.findByText("Save broke")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete flag" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete flag" }));
    expect(await dialog().findByText("Delete broke")).toBeTruthy();
    answer = { status: 204 };
    fireEvent.click(dialog().getByRole("button", { name: "Delete flag" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        `/workspaces/${WS}/flags`,
      ),
    );
    expect(await screen.findByText("Flag new-checkout deleted")).toBeTruthy();
  });

  it("a text flag needs a value for every chosen user", async () => {
    const text = stringFlag();
    gateway().ws("GET", "/flags/{*}", () => ({
      status: 200,
      body: {
        ...text,
        environments: {
          ...text.environments,
          production: {
            enabled: true,
            rules: [
              {
                conditions: [
                  {
                    attribute: "email",
                    operator: "in",
                    values: ["ada@example.com"],
                  },
                ],
                value: "beta",
              },
            ],
            defaultValue: "stable",
          },
        },
      },
    }));
    gateway().ws("POST", "/flags/evaluate", () => ({
      status: 200,
      body: {
        environment: "production",
        flags: { "banner-text": { value: "beta", reason: "rule" } },
      },
    }));
    await open("banner-text");
    expect(await screen.findByText('ada@example.com get "beta".')).toBeTruthy();
    expect(screen.getByText('Everyone else get "stable".')).toBeTruthy();
    expect(
      screen.getByText(/A text flag: your app gets one of the values/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What ada@example.com gets"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save production" }));
    expect(screen.getByText("Give every chosen user a value.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText('"beta"')).toBeTruthy();
  });

  it("refuses more chosen users than fit in one flag", async () => {
    const base = flag();
    const emails = Array.from({ length: 1001 }, (_, i) => `u${i}@x.io`);
    gateway().ws("GET", "/flags/{*}", () => ({
      status: 200,
      body: {
        ...base,
        environments: {
          ...base.environments,
          production: {
            enabled: true,
            rules: [
              {
                conditions: [
                  { attribute: "email", operator: "in", values: emails },
                ],
                value: true,
              },
            ],
            defaultValue: false,
          },
        },
      },
    }));
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Save production" }),
    );
    expect(
      screen.getByText("Too many users for one flag: choose fewer."),
    ).toBeTruthy();
  });

  it("members can check but not change", async () => {
    gateway().ws("GET", "/flags/{*}", () => ({
      status: 200,
      body: targeted(),
    }));
    await open("new-checkout", "member");
    expect(
      await screen.findByText(/Only workspace owners can change flags/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Save production" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete flag" })).toBeNull();
  });

  it("a missing flag", async () => {
    gateway().fail("GET", "/flags/{*}", 404, "NOT_FOUND", "No flag");
    await open("gone");
    expect(await screen.findByText(/This flag doesn.t exist/)).toBeTruthy();
  });

  it("a flag load error", async () => {
    gateway().fail("GET", "/flags/{*}");
    await open();
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});
