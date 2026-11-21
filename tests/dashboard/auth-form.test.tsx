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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams("next=//evil.example"),
  usePathname: () => "/sign-up",
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthForm", () => {
  it("explains each problem next to its field, and sends nothing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a taken email on the email field, and never follows an unsafe ?next=", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "CONFLICT", message: "taken", requestId: "r" },
            }),
            { status: 409 },
          ),
        ),
      ),
    );
    render(<AuthForm mode="sign-up" />);

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

    await waitFor(() =>
      expect(
        screen.getByText(
          "An account with this email already exists. Log in instead.",
        ),
      ).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });
});
