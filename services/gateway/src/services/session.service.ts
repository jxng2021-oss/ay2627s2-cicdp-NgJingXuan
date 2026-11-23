import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import type { Session, User } from "../db/schema.js";
import {
  findSession,
  findSessionByRefresh,
  insertSession,
  revokeSession,
  rotateSession,
  touchSession,
} from "../models/session.model.js";

export interface SessionSettings {
  secret: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  refreshGraceMs: number;
  cookieSecure: boolean;
}

export const COOKIE_PATH = "/dashboard";
export const DEFAULT_REFRESH_GRACE_MS = 30_000;

export function cookieName(settings: SessionSettings): string {
  return settings.cookieSecure ? "__Secure-scp_session" : "scp_session";
}
export function refreshCookieName(settings: SessionSettings): string {
  return settings.cookieSecure ? "__Secure-scp_refresh" : "scp_refresh";
}

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const newToken = () => randomBytes(32).toString("base64url");

export function csrfTokenFor(
  settings: SessionSettings,
  sessionId: string,
): string {
  return createHmac("sha256", settings.secret)
    .update(`csrf:${sessionId}`)
    .digest("base64url");
}

export function csrfTokenMatches(
  settings: SessionSettings,
  sessionId: string,
  given: string | string[] | undefined,
): boolean {
  if (typeof given !== "string") return false;
  const expected = Buffer.from(csrfTokenFor(settings, sessionId));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startSession(
  db: Database,
  settings: SessionSettings,
  reply: FastifyReply,
  userId: string,
  origin: { ip?: string; userAgent?: string } = {},
): Promise<void> {
  const access = newToken();
  const refresh = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + settings.refreshTtlMs);
  await insertSession(db, {
    userId,
    tokenHash: hashToken(access),
    accessExpiresAt: new Date(now + settings.accessTtlMs),
    refreshHash: hashToken(refresh),
    expiresAt,
    ip: origin.ip,
    userAgent: origin.userAgent?.slice(0, 200),
  });
  setSessionCookies(reply, settings, access, refresh, expiresAt);
}

export function clearSessionCookie(
  reply: FastifyReply,
  settings: SessionSettings,
): void {
  reply.header("set-cookie", [
    cookie(settings, cookieName(settings), "", 0, "Lax"),
    cookie(settings, refreshCookieName(settings), "", 0, "Strict"),
  ]);
}

function setSessionCookies(
  reply: FastifyReply,
  settings: SessionSettings,
  access: string,
  refresh: string,
  expiresAt: Date,
): void {
  const untilEnd = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  const accessSeconds = Math.min(
    untilEnd,
    Math.floor(settings.accessTtlMs / 1000),
  );
  reply.header("set-cookie", [
    cookie(settings, cookieName(settings), access, accessSeconds, "Lax"),
    cookie(settings, refreshCookieName(settings), refresh, untilEnd, "Strict"),
  ]);
}

function cookie(
  settings: SessionSettings,
  name: string,
  value: string,
  maxAgeSeconds: number,
  sameSite: "Lax" | "Strict",
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];
  if (settings.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export const OAUTH_COOKIE_PATH = "/dashboard/v1/auth/oauth";
const OAUTH_STATE = /^[a-z]+\.[A-Za-z0-9_-]{43}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/;

function oauthCookieName(settings: SessionSettings): string {
  return settings.cookieSecure ? "__Secure-scp_oauth" : "scp_oauth";
}

export function setOAuthStateCookie(
  reply: FastifyReply,
  settings: SessionSettings,
  value: string,
  maxAgeSeconds: number,
): void {
  const parts = [
    `${oauthCookieName(settings)}=${value}`,
    `Path=${OAUTH_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (settings.cookieSecure) parts.push("Secure");
  reply.header("set-cookie", parts.join("; "));
}

export function readOAuthStateCookie(
  request: FastifyRequest,
  settings: SessionSettings,
): string | undefined {
  const prefix = `${oauthCookieName(settings)}=`;
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      const state = value.slice(prefix.length);
      return OAUTH_STATE.test(state) ? state : undefined;
    }
  }
  return undefined;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) {
      const token = value.slice(prefix.length);
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
    }
  }
  return undefined;
}

export interface ActiveSession {
  session: Session;
  user: User;
}

function stillAlive(
  found: { session: Session; user: User },
  now: number,
): boolean {
  return (
    found.user.status === "active" && found.session.expiresAt.getTime() > now
  );
}

export async function currentSession(
  db: Database,
  settings: SessionSettings,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ActiveSession | undefined> {
  const now = Date.now();

  const access = readCookie(request, cookieName(settings));
  if (access) {
    const found = await findSession(db, hashToken(access));
    if (
      found &&
      found.session.accessExpiresAt.getTime() > now &&
      stillAlive(found, now)
    ) {
      if (now - found.session.lastUsedAt.getTime() > 60_000) {
        await touchSession(db, found.session.id);
      }
      return found;
    }
  }

  const refresh = readCookie(request, refreshCookieName(settings));
  if (!refresh) {
    if (access) clearSessionCookie(reply, settings);
    return undefined;
  }
  const refreshHash = hashToken(refresh);
  const found = await findSessionByRefresh(db, refreshHash);
  if (!found || !stillAlive(found, now)) {
    clearSessionCookie(reply, settings);
    return undefined;
  }

  if (found.session.refreshHash === refreshHash) {
    const nextAccess = newToken();
    const nextRefresh = newToken();
    const expiresAt = new Date(now + settings.refreshTtlMs);
    const rotated = await rotateSession(db, found.session.id, refreshHash, {
      tokenHash: hashToken(nextAccess),
      accessExpiresAt: new Date(now + settings.accessTtlMs),
      refreshHash: hashToken(nextRefresh),
      previousRefreshUntil: new Date(now + settings.refreshGraceMs),
      expiresAt,
    });
    if (rotated) {
      setSessionCookies(reply, settings, nextAccess, nextRefresh, expiresAt);
    }
    return found;
  }

  const graceUntil = found.session.previousRefreshUntil?.getTime() ?? 0;
  if (now < graceUntil) {
    return found;
  }
  await revokeSession(db, found.session.id);
  request.log.warn(
    { sessionId: found.session.id, userId: found.user.id },
    "a replaced refresh token was used again; the session was revoked",
  );
  clearSessionCookie(reply, settings);
  return undefined;
}
