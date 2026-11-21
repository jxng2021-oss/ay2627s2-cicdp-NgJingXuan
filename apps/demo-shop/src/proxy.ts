import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, isAdminSession } from "./lib/admin-auth";
import { refreshShopper, type ShopperTokens } from "./lib/platform/client";
import { ACCESS_COOKIE, REFRESH_COOKIE, tokenCookies } from "./lib/shoppers";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    (path === "/admin" || path.startsWith("/admin/")) &&
    !isAdminSession(request.cookies.get(ADMIN_COOKIE)?.value)
  ) {
    const login = new URL("/admin-login", request.url);
    login.searchParams.set("next", path);
    return NextResponse.redirect(login, 303);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  let renewed: ShopperTokens | null | undefined;
  if (refresh && !request.cookies.get(ACCESS_COOKIE)) {
    renewed = await refreshShopper(refresh).catch(() => null);
    const jar = request.cookies
      .getAll()
      .filter((c) => c.name !== ACCESS_COOKIE && c.name !== REFRESH_COOKIE)
      .map((c) => `${c.name}=${c.value}`);
    if (renewed) {
      jar.push(
        `${ACCESS_COOKIE}=${renewed.accessToken}`,
        `${REFRESH_COOKIE}=${renewed.refreshToken}`,
      );
    }
    headers.set("cookie", jar.join("; "));
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  if (renewed) {
    for (const cookie of tokenCookies(renewed)) response.cookies.set(cookie);
  } else if (renewed === null) {
    response.cookies.delete(REFRESH_COOKIE);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};
