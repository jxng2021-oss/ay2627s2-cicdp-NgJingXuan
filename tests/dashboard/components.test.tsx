import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, ErrorState, shorten, Status } from "@/components/ui";
import { ApiError, NetworkError } from "@/lib/api/client";
import { loginUrl, safeNext } from "@/lib/safe-redirect";

afterEach(cleanup);

describe("ErrorState", () => {
  it("shows an expected error's own message, without alarm", () => {
    render(
      <ErrorState
        error={new ApiError(404, "NOT_FOUND", "Secret not found", "req-1")}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("Secret not found");
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("shows the request ID on an unexpected error, so it can be traced", () => {
    render(
      <ErrorState
        error={
          new ApiError(
            500,
            "INTERNAL_ERROR",
            "Something went wrong",
            "3f2c9b1e-6a4d",
          )
        }
      />,
    );

    expect(
      screen.getByText("Something went wrong", { selector: ".banner-title" }),
    ).toBeTruthy();
    expect(screen.getByText("3f2c9b1e-6a4d").tagName).toBe("CODE");
  });

  it("explains a network failure and offers a retry", () => {
    const retry = vi.fn();
    render(<ErrorState error={new NetworkError()} onRetry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry request" }));

    expect(screen.getByRole("alert").textContent).toMatch(
      /Couldn't reach the dashboard/,
    );
    expect(retry).toHaveBeenCalled();
  });

  it("renders error text from the server as text, never as HTML", () => {
    render(
      <ErrorState
        error={
          new ApiError(400, "BAD_REQUEST", "<img src=x onerror=alert(1)>", "r")
        }
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("ConfirmDialog", () => {
  it("asks before acting, and names the action", () => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
    };
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete secret"
        confirmLabel="Delete secret"
        busyLabel="Deleting..."
        busy={false}
        onConfirm={confirm}
        onCancel={cancel}
      >
        <p>db-password will be deleted.</p>
      </ConfirmDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete secret" }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("Status", () => {
  it("always has a word, not just a colour", () => {
    render(<Status tone="danger">Sealed</Status>);

    expect(screen.getByText("Sealed")).toBeTruthy();
  });
});

describe("returning after login", () => {
  it.each([
    [
      "/workspaces/0d1f3c5e-7a9b-4c2d-8e6f-1a3b5c7d9e0f/secrets",
      "/workspaces/0d1f3c5e-7a9b-4c2d-8e6f-1a3b5c7d9e0f/secrets",
    ],
    ["/account", "/account"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/workspaces", "/"],
    ["/workspaces/x/secrets?next=//evil", "/"],
    ["javascript:alert(1)", "/"],
    ["/workspaces/%2f%2fevil", "/"],
    [null, "/"],
  ])("only allows this app's own pages: %s -> %s", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it("puts only safe pages in the login link", () => {
    expect(loginUrl("/account")).toBe("/login?next=%2Faccount");
    expect(loginUrl("/somewhere-else")).toBe("/login");
  });
});

describe("shorten", () => {
  it("keeps short values and shortens long ones from both ends", () => {
    expect(shorten("abc")).toBe("abc");
    const id = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";
    expect(shorten(id)).toBe("3f2c9b1e-6a4…5e6f70");
  });
});
