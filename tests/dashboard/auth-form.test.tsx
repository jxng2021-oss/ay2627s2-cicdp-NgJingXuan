import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "@/components/auth-form";

const replace = vi.fn();
let search = "next=//evil.example";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/sign-up",
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  search = "next=//evil.example";
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function gateway(
  answer: (url: string, init?: RequestInit) => Promise<Response>,
  providers: string[] = [],
) {
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    url.endsWith("/auth/oauth/providers")
      ? json({ providers })
      : answer(url, init),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const posts = (fetch: ReturnType<typeof gateway>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST");

function fillSignUp() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "a@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "a-long-enough-password" },
  });
  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Create your workspace" }),
  );
}

describe("AuthForm", () => {
  it("explains each problem next to its field, and sends nothing", () => {
    const fetch = gateway(() => json({}));
    render(<AuthForm mode="sign-up" />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "short" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create your workspace" }),
    );

    expect(
      screen.getByText("Enter an email address, like you@example.com."),
    ).toBeTruthy();
    expect(screen.getByText("Use at least 12 characters.")).toBeTruthy();
    expect(screen.getByText("Name your first workspace.")).toBeTruthy();
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(posts(fetch)).toEqual([]);
  });

  it("shows a taken email on the email field, and never follows an unsafe ?next=", async () => {
    gateway(() =>
      json(
        { error: { code: "CONFLICT", message: "taken", requestId: "r" } },
        409,
      ),
    );
    render(<AuthForm mode="sign-up" />);

    fillSignUp();

    await waitFor(() =>
      expect(
        screen.getByText(
          "An account with this email already exists. Log in instead.",
        ),
      ).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows Continue with Google and GitHub only for providers that are set up, as links to the gateway", async () => {
    gateway(() => json({}), ["google", "github"]);
    render(<AuthForm mode="login" />);

    const google = await screen.findByRole("link", {
      name: "Continue with Google",
    });
    expect(google.getAttribute("href")).toBe(
      "/dashboard/v1/auth/oauth/google/start",
    );
    expect(
      screen
        .getByRole("link", { name: "Continue with GitHub" })
        .getAttribute("href"),
    ).toBe("/dashboard/v1/auth/oauth/github/start");

    cleanup();
    gateway(() => json({}), []);
    render(<AuthForm mode="login" />);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Continue with/ })).toBeNull(),
    );
  });

  it("explains why Google or GitHub sign in failed", () => {
    search = "oauth_error=email_unverified";
    gateway(() => json({}));
    render(<AuthForm mode="login" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Your email isn't verified",
    );
  });
});
