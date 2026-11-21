import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "shop_admin";
export const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

const digest = (text: string) => createHash("sha256").update(text).digest();

export function isAdminPassword(
  attempt: string,
  password = process.env.SHOP_ADMIN_PASSWORD,
): boolean {
  if (!password || !attempt) return false;
  return timingSafeEqual(digest(attempt), digest(password));
}

function signature(expires: number, password: string): Buffer {
  return createHmac("sha256", digest(`shop-admin-session:${password}`))
    .update(String(expires))
    .digest();
}

export function newAdminSession(
  now = Date.now(),
  password = process.env.SHOP_ADMIN_PASSWORD,
): string {
  if (!password) throw new Error("admin is off: no SHOP_ADMIN_PASSWORD");
  const expires = now + ADMIN_SESSION_MS;
  return `${expires}.${signature(expires, password).toString("base64url")}`;
}

export function isAdminSession(
  value: string | undefined,
  now = Date.now(),
  password = process.env.SHOP_ADMIN_PASSWORD,
): boolean {
  if (!password || !value) return false;
  const match = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires <= now) return false;
  const given = Buffer.from(match[2]!, "base64url");
  const expected = signature(expires, password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
