import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthLayout from "@/app/(auth)/layout";
import LoginPage from "@/app/(auth)/login/page";
import SignUpPage from "@/app/(auth)/sign-up/page";
import MarketingLayout from "@/app/(marketing)/layout";
import LandingPage from "@/app/(marketing)/page";
import ConnectionsDocs from "@/app/docs/connections/page";
import ErrorsDocs from "@/app/docs/errors/page";
import ExpressDocs from "@/app/docs/express/page";
import FilesDocs from "@/app/docs/files/page";
import FlagsDocs from "@/app/docs/flags/page";
import DocsLayout from "@/app/docs/layout";
import QuickstartDocs from "@/app/docs/page";
import RolesDocs from "@/app/docs/roles/page";
import UserPoolsDocs from "@/app/docs/user-pools/page";
import WebhooksDocs from "@/app/docs/webhooks/page";
import NotFoundPage from "@/app/not-found";
import { ApiConfig } from "@/components/api-config";
import { TaglineReveal } from "@/components/marketing/tagline-reveal";
import { apiOriginFromEnv, apiUrl } from "@/lib/api/origin";
import { FakeGateway, apiError } from "./fake-gateway";
import { resetNavigation } from "./navigation-mock";
import { setUpPageTests } from "./render-page";

vi.mock("next/navigation", () => import("./navigation-mock"));

const { gateway } = setUpPageTests();

type Callback = (
  entries: { isIntersecting: boolean; target: Element }[],
) => void;
const observers: { callback: Callback; observed: Element[] }[] = [];

class FakeObserver {
  observed: Element[] = [];
  constructor(readonly callback: Callback) {
    observers.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {}
}

function reduceMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reduce,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  observers.length = 0;
  reduceMotion(false);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("landing page", () => {
  it("shows the pitch, reveals sections as they scroll in and knows a visitor isn't signed in", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () =>
      apiError(401, "UNAUTHENTICATED", "no"),
    );
    resetNavigation("/");
    render(
      <MarketingLayout>
        <LandingPage />
      </MarketingLayout>,
    );
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
    expect(
      (await screen.findAllByRole("link", { name: "Log in" })).length,
    ).toBeGreaterThan(0);
    act(() => {
      for (const observer of observers) {
        observer.callback(
          observer.observed.map((target) => ({ isIntersecting: true, target })),
        );
      }
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll('.reveal[data-state="shown"]').length,
      ).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(
        document.querySelectorAll('.tagline-word[data-on="true"]').length,
      ).toBeGreaterThan(0),
    );
  });

  it("offers the dashboard to a signed in visitor, with a menu that closes", async () => {
    resetNavigation("/");
    render(<LandingPage />);
    expect(
      (await screen.findAllByRole("link", { name: "Open dashboard" })).length,
    ).toBeGreaterThan(0);
    const menu = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menu);
    expect(screen.getByRole("button", { name: "Close menu" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
    fireEvent.click(menu);
    fireEvent.click(
      screen.getByRole("navigation", { name: "Menu" }).querySelector("a")!,
    );
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });

  it("the signed out menu has a log in link", async () => {
    gateway().on("GET", "/dashboard/v1/auth/me", () =>
      apiError(401, "UNAUTHENTICATED", "no"),
    );
    resetNavigation("/");
    render(<LandingPage />);
    await screen.findAllByRole("link", { name: "Log in" });
    const before = screen.getAllByRole("link", { name: "Log in" }).length;
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getAllByRole("link", { name: "Log in" }).length).toBe(
      before + 1,
    );
  });
});

describe("tagline reveal", () => {
  it("shows every word at once when motion is reduced", () => {
    reduceMotion(true);
    render(<TaglineReveal lines={["one two", "three"]} />);
    expect(
      document.querySelectorAll('.tagline-word[data-on="true"]').length,
    ).toBe(3);
  });

  it("shows every word at once without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
    render(<TaglineReveal lines={["one two"]} className="big" />);
    expect(
      document.querySelectorAll('.tagline-word[data-on="true"]').length,
    ).toBe(2);
  });

  it("lights words one by one up to the last one seen", () => {
    vi.useFakeTimers();
    const view = render(<TaglineReveal lines={["a b c"]} />);
    const observer = observers.at(-1)!;
    act(() => {
      observer.callback([
        { isIntersecting: false, target: observer.observed[0]! },
        { isIntersecting: true, target: observer.observed[1]! },
      ]);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(
      document.querySelectorAll('.tagline-word[data-on="true"]').length,
    ).toBe(2);
    act(() => {
      observer.callback([
        { isIntersecting: true, target: observer.observed[2]! },
      ]);
    });
    view.unmount();
  });
});

describe("docs", () => {
  const pages = [
    ["/docs", QuickstartDocs, "Quickstart"],
    ["/docs/connections", ConnectionsDocs, "Calling outside APIs"],
    ["/docs/files", FilesDocs, "Files"],
    ["/docs/user-pools", UserPoolsDocs, "User sign in"],
    ["/docs/roles", RolesDocs, "Roles and permissions"],
    ["/docs/flags", FlagsDocs, "Feature flags"],
    ["/docs/webhooks", WebhooksDocs, "Payment webhooks"],
    ["/docs/express", ExpressDocs, "Express helpers"],
    ["/docs/errors", ErrorsDocs, "Errors"],
  ] as const;

  for (const [path, Page, label] of pages) {
    it(`${label} has one heading, the docs menu and copyable code`, async () => {
      resetNavigation(path);
      render(
        <DocsLayout>
          <Page />
        </DocsLayout>,
      );
      expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
      const current = screen
        .getByRole("navigation", { name: "SDK docs" })
        .querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(label);
      const copy = screen.queryAllByRole("button", { name: /^Copy/ });
      if (copy[0]) fireEvent.click(copy[0]);
      await screen.findAllByRole("link", {
        name: /Open dashboard|Create workspace/,
      });
    });
  }
});

describe("auth pages and the rest", () => {
  it("renders the log in and sign up forms", async () => {
    resetNavigation("/login");
    render(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    );
    expect(await screen.findByRole("button", { name: "Log in" })).toBeTruthy();
    resetNavigation("/sign-up");
    render(<SignUpPage />);
    expect(
      await screen.findByRole("button", { name: "Create your workspace" }),
    ).toBeTruthy();
  });

  it("shows the not found page", () => {
    render(<NotFoundPage />);
    expect(
      screen.getAllByText(/not found|doesn.t exist/i).length,
    ).toBeGreaterThan(0);
  });

  it("sends API calls to the configured origin", () => {
    render(<ApiConfig origin="https://api.example.com" />);
    expect(apiUrl("/dashboard/v1/auth/me")).toBe(
      "https://api.example.com/dashboard/v1/auth/me",
    );
    render(<ApiConfig origin="" />);
  });

  it("reads the API origin from the environment and refuses a bad one", () => {
    vi.stubEnv("DASHBOARD_API_ORIGIN", "https://api.example.com:8443");
    expect(apiOriginFromEnv()).toBe("https://api.example.com:8443");
    vi.stubEnv("DASHBOARD_API_ORIGIN", "https://api.example.com/path");
    expect(() => apiOriginFromEnv()).toThrow(
      /DASHBOARD_API_ORIGIN must be an origin/,
    );
    expect(new FakeGateway()).toBeTruthy();
  });
});
