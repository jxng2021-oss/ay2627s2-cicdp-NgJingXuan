import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ApiKeysPage from "@/app/workspaces/[workspaceId]/api-keys/page";
import ConnectionsPage from "@/app/workspaces/[workspaceId]/connections/page";
import FilePage from "@/app/workspaces/[workspaceId]/files/[fileId]/page";
import FilesPage from "@/app/workspaces/[workspaceId]/files/page";
import OverviewPage from "@/app/workspaces/[workspaceId]/page";
import SecretPage from "@/app/workspaces/[workspaceId]/secrets/[name]/page";
import SecretsPage from "@/app/workspaces/[workspaceId]/secrets/page";
import { FILE_ID, WS, apiError } from "./fake-gateway";
import { nav } from "./navigation-mock";
import {
  clipboardWrite,
  renderInWorkspace,
  setUpPageTests,
} from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();

const dialog = () => within(screen.getByRole("dialog"));

describe("workspace overview", () => {
  it("shows the role, counts, storage, seal state and activity", async () => {
    await renderInWorkspace(gateway(), <OverviewPage />);
    expect(
      await screen.findByRole("heading", { name: "Acme shop" }),
    ).toBeTruthy();
    expect(screen.getByText("Owner", { selector: ".stat-value" })).toBeTruthy();
    expect(screen.getByText("Unsealed")).toBeTruthy();
    expect(screen.getByText("2.3 MB")).toBeTruthy();
    await waitFor(() =>
      expect(gateway().called("GET", "/analytics").length).toBeGreaterThan(0),
    );
  });

  it("warns on every page while the secrets service is sealed", async () => {
    await renderInWorkspace(gateway(), <OverviewPage />, {
      role: "member",
      sealed: true,
    });
    expect(await screen.findByText("Secrets are sealed")).toBeTruthy();
    expect(screen.getByText("Sealed")).toBeTruthy();
    expect(screen.getByText("Unavailable while sealed")).toBeTruthy();
    expect(
      screen.getByText("Member", { selector: ".stat-value" }),
    ).toBeTruthy();
  });

  it("shows unknown when the seal state can't be read", async () => {
    gateway().on("GET", `/dashboard/v1/workspaces/${WS}`, () => ({
      status: 200,
      body: {
        id: WS,
        name: "Acme shop",
        role: "owner",
        secretsCount: null,
        fileCount: null,
        storage: null,
        secretsSealed: null,
      },
    }));
    await renderInWorkspace(gateway(), <OverviewPage />);
    expect(await screen.findByText("Unknown")).toBeTruthy();
  });
});

describe("workspace layout", () => {
  it("sends a signed out visitor to log in", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () =>
      apiError(401, "UNAUTHENTICATED", "Log in first"),
    );
    await renderInWorkspace(gateway(), <OverviewPage />);
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        expect.stringContaining("/login?next="),
      ),
    );
  });

  it("shows not found for a workspace the user isn't in", async () => {
    gateway().on("GET", `/dashboard/v1/workspaces/${WS}`, () =>
      apiError(404, "NOT_FOUND", "Workspace not found"),
    );
    await renderInWorkspace(gateway(), <OverviewPage />);
    expect(
      (await screen.findAllByText(/not found|doesn.t exist/i)).length,
    ).toBeGreaterThan(0);
  });

  it("shows an error with a retry when loading fails", async () => {
    gateway().on("GET", `/dashboard/v1/workspaces/${WS}`, () =>
      apiError(500, "INTERNAL_ERROR", "Something went wrong"),
    );
    await renderInWorkspace(gateway(), <OverviewPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry request" }),
    );
    await waitFor(() =>
      expect(
        gateway().calls.filter(
          (c) => c.path === `/dashboard/v1/workspaces/${WS}`,
        ).length,
      ).toBe(2),
    );
  });

  it("lets an owner finish deleting a half deleted workspace", async () => {
    gateway().on("GET", `/dashboard/v1/workspaces/${WS}`, () =>
      apiError(409, "WORKSPACE_DELETING", "Being deleted"),
    );
    await renderInWorkspace(gateway(), <OverviewPage />);
    expect(await screen.findByText("Workspace being deleted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finish deletion" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("tells a member that an owner must finish the deletion", async () => {
    gateway().on("GET", `/dashboard/v1/workspaces/${WS}`, () =>
      apiError(409, "WORKSPACE_DELETING", "Being deleted"),
    );
    await renderInWorkspace(gateway(), <OverviewPage />, { role: "member" });
    expect(
      await screen.findByText(/An owner can finish the deletion/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Finish deletion" }),
    ).toBeNull();
  });

  it("opens and closes the mobile menu", async () => {
    await renderInWorkspace(gateway(), <OverviewPage />);
    const toggle = await screen.findByRole("button", { name: /menu/i });
    fireEvent.click(toggle);
    expect(document.getElementById("sidebar")?.dataset.open).toBe("true");
    fireEvent.click(toggle);
    expect(document.getElementById("sidebar")?.dataset.open).toBe("false");
  });
});

describe("API keys", () => {
  it("creates a key and shows it once, with copy and hide", async () => {
    await renderInWorkspace(gateway(), <ApiKeysPage />, { path: "/api-keys" });
    expect(await screen.findByText("shop-server")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    fireEvent.click(dialog().getByRole("button", { name: "Create API key" }));
    expect(dialog().getByText("Name the key, like ci-deploy.")).toBeTruthy();
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "ci-deploy" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create API key" }));
    expect(await screen.findByLabelText("New API key")).toBeTruthy();
    expect(gateway().called("POST", "/api-keys")[0]?.body).toEqual({
      name: "ci-deploy",
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(clipboardWrite).toHaveBeenCalledWith("sk_live_the-full-new-key");
    fireEvent.click(screen.getByRole("button", { name: "Hide API key" }));
    expect(screen.queryByLabelText("New API key")).toBeNull();
  });

  it("shows why creating a key failed", async () => {
    gateway().fail("POST", "/api-keys", 409, "CONFLICT", "That name is taken");
    await renderInWorkspace(gateway(), <ApiKeysPage />, { path: "/api-keys" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create API key" }),
    );
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "shop-server" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Create API key" }));
    expect(await dialog().findByText("That name is taken")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
  });

  it("revokes an active key and removes a revoked one after confirming", async () => {
    await renderInWorkspace(gateway(), <ApiKeysPage />, { path: "/api-keys" });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke key" }));
    fireEvent.click(dialog().getByRole("button", { name: "Revoke key" }));
    expect(await screen.findByText("API key shop-server revoked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(dialog().getByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("API key old-key removed")).toBeTruthy();
  });

  it("keeps the dialog open with the error when revoking fails", async () => {
    gateway().fail("DELETE", "/api-keys/{*}");
    gateway().fail("DELETE", "/revoked-api-keys/{*}");
    await renderInWorkspace(gateway(), <ApiKeysPage />, { path: "/api-keys" });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke key" }));
    fireEvent.click(dialog().getByRole("button", { name: "Revoke key" }));
    expect(
      (await dialog().findAllByText("Something went wrong")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(dialog().getByRole("button", { name: "Remove key" }));
    expect(
      (await dialog().findAllByText("Something went wrong")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("members see keys but no buttons, and an empty list says who can add one", async () => {
    gateway().ws("GET", "/api-keys", () => ({
      status: 200,
      body: { apiKeys: [] },
    }));
    await renderInWorkspace(gateway(), <ApiKeysPage />, {
      path: "/api-keys",
      role: "member",
    });
    expect(await screen.findByText(/An owner can create one/)).toBeTruthy();
    expect(screen.getByText("Viewing as a member")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create API key" })).toBeNull();
  });

  it("shows a load error", async () => {
    gateway().fail("GET", "/api-keys");
    await renderInWorkspace(gateway(), <ApiKeysPage />, { path: "/api-keys" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("secrets", () => {
  it("lists secrets, pages through them and creates one", async () => {
    await renderInWorkspace(gateway(), <SecretsPage />, { path: "/secrets" });
    expect(await screen.findByText("stripe-secret-key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(
        gateway().called("GET", "/secrets").at(-1)?.query.get("cursor"),
      ).toBe("next-page"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "First page" }));

    fireEvent.click(screen.getByRole("button", { name: "Create secret" }));
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "-bad name" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Save secret" }));
    expect(dialog().getByText(/Use 1 to 128 letters/)).toBeTruthy();
    expect(dialog().getByText("Enter the value to store.")).toBeTruthy();
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "mail-key" },
    });
    fireEvent.change(dialog().getByLabelText(/^Value/), {
      target: { value: "s3cret-value" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Save secret" }));
    expect(await screen.findByText("Secret mail-key saved")).toBeTruthy();
    expect(gateway().called("PUT", "/secrets/mail-key")[0]?.body).toEqual({
      value: "s3cret-value",
    });
  });

  it("shows a failed save in the dialog", async () => {
    gateway().fail(
      "PUT",
      "/secrets/{*}",
      503,
      "SECRETS_SEALED",
      "The vault is sealed",
    );
    await renderInWorkspace(gateway(), <SecretsPage />, { path: "/secrets" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create secret" }),
    );
    fireEvent.change(dialog().getByLabelText(/^Name/), {
      target: { value: "a" },
    });
    fireEvent.change(dialog().getByLabelText(/^Value/), {
      target: { value: "b" },
    });
    fireEvent.click(dialog().getByRole("button", { name: "Save secret" }));
    expect(await dialog().findByText("The vault is sealed")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an empty list for a member", async () => {
    gateway().ws("GET", "/secrets", () => ({
      status: 200,
      body: { secrets: [], nextCursor: null },
    }));
    await renderInWorkspace(gateway(), <SecretsPage />, {
      path: "/secrets",
      role: "member",
    });
    expect(await screen.findByText(/No secrets yet/)).toBeTruthy();
  });

  it("shows when the list fails to load", async () => {
    gateway().fail("GET", "/secrets");
    await renderInWorkspace(gateway(), <SecretsPage />, { path: "/secrets" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });

  it("shows a secret's versions, rotates it and deletes it", async () => {
    await renderInWorkspace(gateway(), <SecretPage />, {
      path: "/secrets/stripe-secret-key",
      params: { name: "stripe-secret-key" },
    });
    expect(await screen.findByText("v2 (current)")).toBeTruthy();
    expect(screen.getByText(/as version 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(screen.getByText("Enter the new value.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^New value/), {
      target: { value: "new-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(
      await screen.findByText("Secret stripe-secret-key rotated"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete secret" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete secret" }));
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith(
        `/workspaces/${WS}/secrets`,
      ),
    );
  });

  it("shows rotate and delete failures", async () => {
    gateway().fail(
      "POST",
      "/secrets/{*}/rotate",
      503,
      "SECRETS_SEALED",
      "Sealed now",
    );
    gateway().fail(
      "DELETE",
      "/secrets/{*}",
      500,
      "INTERNAL_ERROR",
      "Delete broke",
    );
    await renderInWorkspace(gateway(), <SecretPage />, {
      path: "/secrets/stripe-secret-key",
      params: { name: "stripe-secret-key" },
    });
    fireEvent.change(await screen.findByLabelText(/^New value/), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByText("Sealed now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete secret" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete secret" }));
    expect(await dialog().findByText("Delete broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("members can only view, even with a name that can't be decoded", async () => {
    await renderInWorkspace(gateway(), <SecretPage />, {
      path: "/secrets/%E0%A4%A",
      params: { name: "%E0%A4%A" },
      role: "member",
    });
    expect(
      await screen.findByText(/Only workspace owners can rotate/),
    ).toBeTruthy();
  });

  it("says when a secret doesn't exist", async () => {
    gateway().fail(
      "GET",
      "/secrets/{*}/versions",
      404,
      "NOT_FOUND",
      "No secret",
    );
    await renderInWorkspace(gateway(), <SecretPage />, {
      path: "/secrets/gone",
      params: { name: "gone" },
    });
    expect(await screen.findByText(/This secret doesn.t exist/)).toBeTruthy();
  });

  it("shows a version load error", async () => {
    gateway().fail("GET", "/secrets/{*}/versions");
    await renderInWorkspace(gateway(), <SecretPage />, {
      path: "/secrets/x",
      params: { name: "x" },
    });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

class FakeUpload {
  static status = 201;
  static response = "";
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 0;
  responseText = "";
  withCredentials = false;
  headers: Record<string, string> = {};
  open = vi.fn();
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return "req-1";
  }
  send() {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 5,
      total: 10,
    } as ProgressEvent);
    setTimeout(() => {
      if (FakeUpload.status === 0) {
        this.onerror?.();
        return;
      }
      this.status = FakeUpload.status;
      this.responseText = FakeUpload.response;
      this.onload?.();
    }, 10);
  }
}

describe("files", () => {
  it("shows storage, lists files and pages through them", async () => {
    gateway().ws("GET", "/usage", () => ({
      status: 200,
      body: {
        usedBytes: 4_900_000_000,
        reservedBytes: 0,
        limitBytes: 5_000_000_000,
      },
    }));
    await renderInWorkspace(gateway(), <FilesPage />, { path: "/files" });
    expect(await screen.findByText("product-mug.jpg")).toBeTruthy();
    expect(screen.getByText("Unnamed")).toBeTruthy();
    expect(
      screen.getByRole("meter", { name: "Storage used" }).dataset.level,
    ).toBe("full");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: "First page" }));
  });

  it("uploads a file with progress", async () => {
    FakeUpload.status = 201;
    FakeUpload.response = JSON.stringify({
      id: FILE_ID,
      size: 10,
      name: "notes.txt",
      contentType: "text/plain",
      createdAt: "2026-11-24T15:30:00.000Z",
    });
    vi.stubGlobal("XMLHttpRequest", FakeUpload);
    await renderInWorkspace(gateway(), <FilesPage />, { path: "/files" });
    await screen.findByText("product-mug.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    const input = document.getElementById("file-upload") as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });
    expect(
      await screen.findByRole("progressbar", { name: "Upload progress" }),
    ).toBeTruthy();
    expect(await screen.findByText("File notes.txt uploaded")).toBeTruthy();
  });

  it("shows why an upload was refused, and a network failure", async () => {
    FakeUpload.status = 413;
    FakeUpload.response = JSON.stringify({
      error: {
        code: "STORAGE_QUOTA_EXCEEDED",
        message: "The workspace is full",
        requestId: "r",
      },
    });
    vi.stubGlobal("XMLHttpRequest", FakeUpload);
    await renderInWorkspace(gateway(), <FilesPage />, { path: "/files" });
    await screen.findByText("product-mug.jpg");
    const input = document.getElementById("file-upload") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([""], "big.bin")] },
    });
    expect(await screen.findByText("The workspace is full")).toBeTruthy();
    FakeUpload.status = 0;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "again.bin")] },
    });
    expect(
      await screen.findByText(/Couldn't reach the dashboard/),
    ).toBeTruthy();
    fireEvent.change(input, { target: { files: [] } });
  });

  it("an empty list, and a nearly full workspace", async () => {
    gateway().ws("GET", "/files", () => ({
      status: 200,
      body: { files: [], nextCursor: null },
    }));
    gateway().ws("GET", "/usage", () => ({
      status: 200,
      body: {
        usedBytes: 4_100_000_000,
        reservedBytes: 0,
        limitBytes: 5_000_000_000,
      },
    }));
    await renderInWorkspace(gateway(), <FilesPage />, { path: "/files" });
    expect(await screen.findByText(/No files yet/)).toBeTruthy();
    expect(
      screen.getByRole("meter", { name: "Storage used" }).dataset.level,
    ).toBe("high");
  });

  it("shows when the file list fails to load", async () => {
    gateway().fail("GET", "/files");
    await renderInWorkspace(gateway(), <FilesPage />, { path: "/files" });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });

  it("shows a file's details, its download link, and deletes it", async () => {
    await renderInWorkspace(gateway(), <FilePage />, {
      path: `/files/${FILE_ID}`,
      params: { fileId: FILE_ID },
    });
    const download = await screen.findByRole("link", { name: "Download file" });
    expect(download.getAttribute("href")).toContain(`/files/${FILE_ID}`);
    expect(screen.getByText("image/jpeg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete file" }));
    expect(
      await screen.findByText("File product-mug.jpg deleted"),
    ).toBeTruthy();
    expect(nav.router.replace).toHaveBeenCalledWith(`/workspaces/${WS}/files`);
  });

  it("disables download while sealed and shows a failed delete", async () => {
    gateway().fail(
      "DELETE",
      "/files/{*}",
      500,
      "INTERNAL_ERROR",
      "Delete broke",
    );
    gateway().ws("GET", "/files/{*}/metadata", () => ({
      status: 200,
      body: {
        id: FILE_ID,
        size: 5,
        name: null,
        contentType: "text/plain",
        createdAt: "2026-11-24T15:30:00.000Z",
      },
    }));
    await renderInWorkspace(gateway(), <FilePage />, {
      path: `/files/${FILE_ID}`,
      params: { fileId: FILE_ID },
      sealed: true,
    });
    expect(await screen.findByText(/Downloads are unavailable/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Unnamed file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    fireEvent.click(dialog().getByRole("button", { name: "Delete file" }));
    expect(await dialog().findByText("Delete broke")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Keep it" }));
  });

  it("a missing file", async () => {
    gateway().fail("GET", "/files/{*}/metadata", 404, "NOT_FOUND", "No file");
    await renderInWorkspace(gateway(), <FilePage />, {
      path: `/files/x`,
      params: { fileId: "x" },
      role: "member",
    });
    expect(await screen.findByText(/This file doesn.t exist/)).toBeTruthy();
  });

  it("file load error", async () => {
    gateway().fail("GET", "/files/{*}/metadata");
    await renderInWorkspace(gateway(), <FilePage />, {
      path: `/files/x`,
      params: { fileId: "x" },
    });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});

describe("connections list", () => {
  it("lists connections with their policy limits", async () => {
    await renderInWorkspace(gateway(), <ConnectionsPage />, {
      path: "/connections",
    });
    expect(await screen.findByText("3 limits")).toBeTruthy();
    expect(screen.getByText("No policy")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Create connection" }),
    ).toBeTruthy();
  });

  it("an empty list for a member", async () => {
    gateway().ws("GET", "/proxy-connections", () => ({
      status: 200,
      body: { connections: [] },
    }));
    await renderInWorkspace(gateway(), <ConnectionsPage />, {
      path: "/connections",
      role: "member",
    });
    expect(await screen.findByText(/An owner can create one/)).toBeTruthy();
  });

  it("shows when the list fails", async () => {
    gateway().fail("GET", "/proxy-connections");
    await renderInWorkspace(gateway(), <ConnectionsPage />, {
      path: "/connections",
    });
    expect(
      await screen.findByRole("button", { name: "Retry request" }),
    ).toBeTruthy();
  });
});
