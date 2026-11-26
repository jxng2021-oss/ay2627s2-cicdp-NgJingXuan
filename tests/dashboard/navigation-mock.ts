import { vi } from "vitest";

export const nav = {
  pathname: "/",
  params: {} as Record<string, string>,
  search: new URLSearchParams(),
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  },
};

export function resetNavigation(
  pathname: string,
  params: Record<string, string> = {},
  search = "",
): void {
  nav.pathname = pathname;
  nav.params = params;
  nav.search = new URLSearchParams(search);
  for (const fn of Object.values(nav.router)) fn.mockReset();
}

export const usePathname = () => nav.pathname;
export const useParams = () => nav.params;
export const useSearchParams = () => nav.search;
export const useRouter = () => nav.router;
export const redirect = (url: string) => {
  throw new Error(`redirect to ${url}`);
};
export const notFound = () => {
  throw new Error("not found");
};
