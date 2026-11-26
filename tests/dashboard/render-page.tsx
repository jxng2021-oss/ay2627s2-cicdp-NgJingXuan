import {
  cleanup,
  configure,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import WorkspaceLayout from "@/app/workspaces/[workspaceId]/layout";
import { clearCsrfToken } from "@/lib/api/client";
import { SessionGate } from "@/lib/session";
import { ToastProvider } from "@/lib/toast";
import { FakeGateway, type Role, WS } from "./fake-gateway";
import { resetNavigation } from "./navigation-mock";

configure({ asyncUtilTimeout: 5000 });

export function installDialogs(): void {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

export const clipboardWrite = vi.fn(() => Promise.resolve());

export function setUpPageTests(): { gateway: () => FakeGateway } {
  let current: FakeGateway | undefined;
  beforeEach(() => {
    installDialogs();
    clearCsrfToken();
    current = new FakeGateway().install();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return { gateway: () => current! };
}

export interface PageOptions {
  path?: string;
  params?: Record<string, string>;
  search?: string;
  role?: Role;
  sealed?: boolean;
}

export async function renderInWorkspace(
  gateway: FakeGateway,
  page: ReactNode,
  options: PageOptions = {},
) {
  gateway.role = options.role ?? "owner";
  gateway.sealed = options.sealed ?? false;
  resetNavigation(
    `/workspaces/${WS}${options.path ?? ""}`,
    { workspaceId: WS, ...options.params },
    options.search,
  );
  const view = render(
    <ToastProvider>
      <SessionGate>
        <WorkspaceLayout>{page}</WorkspaceLayout>
      </SessionGate>
    </ToastProvider>,
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading...")).toBeNull(),
  ).catch(() => undefined);
  return view;
}

export function renderPlain(page: ReactNode, path = "/", search = "") {
  resetNavigation(path, {}, search);
  return render(
    <ToastProvider>
      <SessionGate>{page}</SessionGate>
    </ToastProvider>,
  );
}
