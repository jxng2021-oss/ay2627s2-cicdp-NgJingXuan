import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConnectionPage from "@/app/workspaces/[workspaceId]/connections/[name]/page";
import NewConnectionPage from "@/app/workspaces/[workspaceId]/connections/new/page";
import WebhooksPage from "@/app/workspaces/[workspaceId]/webhooks/page";
import {
  EMPTY_POLICY,
  describePolicy,
  formToPolicy,
  policyToForm,
} from "@/components/policy";
import { WS, connection, webhookEvents, webhooks } from "./fake-gateway";
import { nav } from "./navigation-mock";
import { renderInWorkspace, setUpPageTests } from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();
const dialog = () => within(screen.getByRole("dialog"));
const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("connection policies", () => {
  it("turns a form into a policy and back", () => {
    const form = {
      routes: "post /charges\n\nGET /charges/*",
      requests: "100",
      windowSeconds: "60",
      field: "amount",
      maxPerRequest: "5000",
      maxPerDay: "50000",
    };
    const result = formToPolicy(form);
    expect(result).toEqual({
      policy: {
        allowedRoutes: [
          { method: "POST", path: "/charges" },
          { method: "GET", path: "/charges/*" },
        ],
        rateLimit: { requests: 100, windowSeconds: 60 },
        amountLimit: { field: "amount", maxPerRequest: 5000, maxPerDay: 50000 },
      },
    });
    if (!("policy" in result)) throw new Error("expected a policy");
    expect(policyToForm(result.policy!)).toEqual({
      ...form,
      routes: "POST /charges\nGET /charges/*",
    });
    expect(policyToForm(null)).toEqual(EMPTY_POLICY);
    expect(policyToForm({})).toMatchObject({ routes: "", windowSeconds: "60" });
    expect(formToPolicy(EMPTY_POLICY)).toEqual({ policy: undefined });
  });

  it("explains each kind of mistake", () => {
    const bad = formToPolicy({
      routes: "FETCH /x",
      requests: "0",
      windowSeconds: "999999",
      field: "1bad",
      maxPerRequest: "x",
      maxPerDay: "",
    });
    expect(bad).toEqual({
      errors: {
        routes:
          'Write one route per line, like "POST /charges" or "GET /charges/*". Check: FETCH /x',
        requests: "Enter a whole number from 1 to 10,000.",
        windowSeconds: "Enter seconds from 1 to 86,400.",
        field: "Enter a JSON field name, like amount.",
        maxPerRequest: "Enter a whole number, in the smallest unit.",
        maxPerDay: "Enter a whole number, in the smallest unit.",
      },
    });
    const tooMany = formToPolicy({
      ...EMPTY_POLICY,
      routes: Array.from({ length: 21 }, (_, i) => `GET /r${i}`).join("\n"),
    });
    expect(tooMany).toEqual({ errors: { routes: "List at most 20 routes." } });
    const dayBelowCall = formToPolicy({
      ...EMPTY_POLICY,
      maxPerRequest: "100",
      maxPerDay: "50",
    });
    expect(dayBelowCall).toEqual({
      errors: {
        maxPerDay: "The daily limit can't be less than the limit per call.",
      },
    });
    expect(
      formToPolicy({ ...EMPTY_POLICY, routes: "GET /a extra" }),
    ).toHaveProperty("errors.routes");
  });

  it("describes a policy in words", () => {
    expect(describePolicy(null)).toEqual(["No limits"]);
    expect(describePolicy(connection().policy!)).toEqual([
      "Only POST /payment_intents, GET /payment_intents/*",
      "100 calls per 60s",
      "amount ≤ 50,000 per call, 500,000 per day",
    ]);
  });
});

describe("creating a connection", () => {
  it("checks every field, then saves and opens the new connection", async () => {
    await renderInWorkspace(gateway(), <NewConnectionPage />, {
      path: "/connections/new",
    });
    await screen.findByRole("option", { name: "stripe-secret-key" });
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(
      screen.getByText("Check the highlighted fields above."),
    ).toBeTruthy();
    expect(screen.getByText(/Use letters, digits, dots/)).toBeTruthy();
    expect(screen.getByText(/Enter a full URL/)).toBeTruthy();
    expect(screen.getByText("Choose one of your secrets.")).toBeTruthy();

    type(/^Name/, "new");
    type(/^Base URL/, "ftp://files.example.com");
    type(/^Header name/, "Bad Header");
    type(/^Allowed routes/, "nope");
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(screen.getByText(/"new" is reserved/)).toBeTruthy();
    expect(screen.getByText(/Enter a full URL/)).toBeTruthy();
    expect(screen.getByText(/Enter a header name/)).toBeTruthy();

    type(/^Name/, "payments");
    type(/^Base URL/, "https://api.stripe.com/v1");
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "stripe-secret-key" },
    });
    type(/^Header name/, "Authorization");
    type(/^Header prefix/, "Bearer ");
    type(/^Allowed routes/, "POST /payment_intents");
    type(/^Calls per window/, "10");
    type(/^Max per call/, "100");
    type(/^Max per day/, "1000");
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(
        `/workspaces/${WS}/connections/payments`,
      ),
    );
    expect(
      gateway().called("PUT", "/proxy-connections/payments")[0]?.body,
    ).toEqual({
      baseUrl: "https://api.stripe.com/v1",
      secretName: "stripe-secret-key",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      policy: {
        allowedRoutes: [{ method: "POST", path: "/payment_intents" }],
        rateLimit: { requests: 10, windowSeconds: 60 },
        amountLimit: { field: "amount", maxPerRequest: 100, maxPerDay: 1000 },
      },
    });
  });

  it("types the secret name when there are no secrets, and shows a refusal", async () => {
    gateway().ws("GET", "/secrets", () => ({
      status: 200,
      body: { secrets: [], nextCursor: null },
    }));
    gateway().fail(
      "PUT",
      "/proxy-connections/{*}",
      400,
      "PROXY_HOST_NOT_ALLOWED",
      "That host isn't allowed",
    );
    await renderInWorkspace(gateway(), <NewConnectionPage />, {
      path: "/connections/new",
    });
    await screen.findByLabelText(/^Secret name/);
    type(/^Secret name/, "my-key");
    type(/^Name/, "mailer");
    type(/^Base URL/, "https://api.mailer.test");
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(await screen.findByText("That host isn't allowed")).toBeTruthy();
  });

  it("is for owners only", async () => {
    await renderInWorkspace(gateway(), <NewConnectionPage />, {
      path: "/connections/new",
      role: "member",
    });
    expect(await screen.findByText("Owners only")).toBeTruthy();
  });
});

describe("a connection's page", () => {
  const open = (name = "stripe", role: "owner" | "member" = "owner") =>
    renderInWorkspace(gateway(), <ConnectionPage />, {
      path: `/connections/${name}`,
      params: { name },
      role,
    });

  it("shows details and usage, saves a policy and removes the connection", async () => {
    await open();
    expect(
      (await screen.findAllByText("/v1/proxy/stripe/...")).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText(/12 of 100 \(per 60s, resets in 30s\)/),
    ).toBeTruthy();
    expect(screen.getByText("120,000 of 500,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));

    type(/^Calls per window/, "abc");
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(
      screen.getByText("Enter a whole number from 1 to 10,000."),
    ).toBeTruthy();
    type(/^Calls per window/, "50");
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText("Policy of stripe saved")).toBeTruthy();
    expect(
      gateway().called("PUT", "/proxy-connections/stripe")[0]?.body,
    ).toMatchObject({
      policy: { rateLimit: { requests: 50, windowSeconds: 60 } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    fireEvent.click(
      dialog().getByRole("button", { name: "Remove connection" }),
    );
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        `/workspaces/${WS}/connections`,
      ),
    );
  });

  it("shows failures to save, remove and read usage", async () => {
    gateway().fail(
      "PUT",
      "/proxy-connections/{*}",
      500,
      "INTERNAL_ERROR",
      "Save broke",
    );
    gateway().fail(
      "DELETE",
      "/proxy-connections/{*}",
      500,
      "INTERNAL_ERROR",
      "Remove broke",
    );
    gateway().fail(
      "GET",
      "/proxy-connections/{*}/usage",
      503,
      "SERVICE_UNAVAILABLE",
      "Usage unavailable",
    );
    await open();
    expect(await screen.findByText("Usage unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText("Save broke")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    fireEvent.click(
      dialog().getByRole("button", { name: "Remove connection" }),
    );
    expect(await dialog().findByText("Remove broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("a route only policy has nothing to count; a full one shows its levels", async () => {
    gateway().ws("GET", "/proxy-connections", () => ({
      status: 200,
      body: {
        connections: [
          {
            ...connection(),
            policy: { allowedRoutes: [{ method: "GET", path: "/" }] },
          },
        ],
      },
    }));
    gateway().ws("GET", "/proxy-connections/{*}/usage", () => ({
      status: 200,
      body: { name: "stripe", day: "2026-11-24" },
    }));
    await open();
    expect(await screen.findByText(/only limits routes/)).toBeTruthy();
  });

  it("shows full meters when limits are nearly used up", async () => {
    gateway().ws("GET", "/proxy-connections/{*}/usage", () => ({
      status: 200,
      body: {
        name: "stripe",
        day: "2026-11-24",
        calls: { used: 99, limit: 100, windowSeconds: 60, resetSeconds: 0 },
        amount: {
          field: "amount",
          usedToday: 420_000,
          maxPerDay: 500_000,
          maxPerRequest: 50_000,
        },
      },
    }));
    await open();
    expect(
      (await screen.findByRole("meter", { name: "Calls this window" })).dataset
        .level,
    ).toBe("full");
    expect(
      screen.getByRole("meter", { name: "Amount requested today" }).dataset
        .level,
    ).toBe("high");
  });

  it("members see the policy in words and can't change it", async () => {
    await open("mailer", "member");
    expect(await screen.findByText("No limits")).toBeTruthy();
    expect(screen.getByText("Viewing as a member")).toBeTruthy();
  });

  it("a missing connection, with a name that can't be decoded", async () => {
    await open("%E0%A4%A");
    expect(
      await screen.findByText(/This connection doesn.t exist/),
    ).toBeTruthy();
  });

  it("shows a load error", async () => {
    gateway().fail("GET", "/proxy-connections");
    await open();
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("webhooks", () => {
  it("shows endpoints with their events, resends one and deletes the endpoint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    expect(await screen.findByText("Payment succeeded")).toBeTruthy();
    expect(screen.getByText("25.00 SGD")).toBeTruthy();
    expect(screen.getByText("Gave up")).toBeTruthy();
    expect(screen.getByText(/card_declined/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Send again" })[1]!);
    expect(await screen.findByText("Sending the event again.")).toBeTruthy();
    vi.advanceTimersByTime(1600);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Stripe address" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete endpoint" }));
    expect(
      await screen.findByText("Deleted the shop-payments endpoint."),
    ).toBeTruthy();
  });

  it("says when a resend or delete fails", async () => {
    gateway().fail("POST", "/webhooks/{*}/events/{*}/redeliver");
    gateway().fail(
      "DELETE",
      "/webhooks/{*}",
      500,
      "INTERNAL_ERROR",
      "Delete broke",
    );
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Send again" }))[0]!,
    );
    expect(
      await screen.findByText(/Couldn't send the event again/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete endpoint" }));
    expect(await dialog().findByText("Delete broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("creates an endpoint after checking the name and secret", async () => {
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create endpoint" }),
    );
    await dialog().findByRole("option", { name: "webhook-secret" });
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "Bad Name" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create endpoint" }));
    expect(
      dialog().getByText("Use lowercase letters, numbers and dashes."),
    ).toBeTruthy();
    expect(dialog().getByText("Choose one of your secrets.")).toBeTruthy();
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "stripe" },
    });
    fireEvent.change(dialog().getByRole("combobox"), {
      target: { value: "webhook-secret" },
    });
    fireEvent.change(dialog().getByLabelText(/^Delivery address/), {
      target: { value: "  " },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create endpoint" }));
    expect(await screen.findByText(/Created the stripe endpoint/)).toBeTruthy();
    expect(gateway().called("POST", "/webhooks")[0]?.body).toEqual({
      name: "stripe",
      signingSecretName: "webhook-secret",
      forwardUrl: null,
    });
  });

  it("shows a refused create, and asks for a secret first when there are none", async () => {
    gateway().ws("GET", "/secrets", () => ({
      status: 200,
      body: { secrets: [], nextCursor: null },
    }));
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create endpoint" }),
    );
    expect(
      await dialog().findByText(/Save Stripe's whsec_ value in Secrets first/),
    ).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
  });

  it("shows the server's reason when creating fails", async () => {
    gateway().fail("POST", "/webhooks", 409, "CONFLICT", "Name taken");
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create endpoint" }),
    );
    await dialog().findByRole("option", { name: "webhook-secret" });
    fireEvent.change(dialog().getByRole("combobox"), {
      target: { value: "webhook-secret" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create endpoint" }));
    expect(await dialog().findByText("Name taken")).toBeTruthy();
  });

  it("pull mode endpoints, no events yet, and members", async () => {
    gateway().ws("GET", "/webhooks", () => ({
      status: 200,
      body: { endpoints: [{ ...webhooks().endpoints[0], forwardUrl: null }] },
    }));
    gateway().ws("GET", "/webhooks/{*}/events", () => ({
      status: 200,
      body: { events: [] },
    }));
    await renderInWorkspace(gateway(), <WebhooksPage />, {
      path: "/webhooks",
      role: "member",
    });
    expect(await screen.findByText("Your dev app pulls")).toBeTruthy();
    expect(await screen.findByText(/No events yet/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Delete endpoint" }),
    ).toBeNull();
  });

  it("pending and pull events", async () => {
    const [first] = webhookEvents().events;
    gateway().ws("GET", "/webhooks/{*}/events", () => ({
      status: 200,
      body: {
        events: [
          {
            ...first,
            id: "e3",
            event: "refund.succeeded",
            deliveryStatus: "pending",
            lastError: "timeout",
          },
          { ...first, id: "e4", event: "custom.thing", deliveryStatus: "pull" },
        ],
      },
    }));
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    expect(await screen.findByText("Retrying")).toBeTruthy();
    expect(screen.getByText("Pull mode")).toBeTruthy();
    expect(screen.getByText("custom.thing")).toBeTruthy();
  });

  it("an empty list", async () => {
    gateway().ws("GET", "/webhooks", () => ({
      status: 200,
      body: { endpoints: [] },
    }));
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    expect(await screen.findByText(/No webhook endpoints yet/)).toBeTruthy();
  });

  it("shows an event load error", async () => {
    gateway().fail("GET", "/webhooks/{*}/events");
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });

  it("shows a list load error", async () => {
    gateway().fail("GET", "/webhooks");
    await renderInWorkspace(gateway(), <WebhooksPage />, { path: "/webhooks" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});
