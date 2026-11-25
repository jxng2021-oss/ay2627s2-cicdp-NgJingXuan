import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { OAuthProviderId } from "../models/oauth.model.js";

export type { OAuthProviderId } from "../models/oauth.model.js";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface OAuthSettings {
  redirectOrigin: string;
  google: OAuthClient | undefined;
  github: OAuthClient | undefined;
}

export interface OAuthProfile {
  subject: string;
  email: string;
  name: string | null;
}

export type OAuthFailure = "failed" | "email_unverified";
export type OAuthStep = "token" | "profile";

export interface OAuthFailureDetail {
  step?: OAuthStep;
  status?: number;
  providerError?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly reason: OAuthFailure,
    readonly detail: OAuthFailureDetail = {},
  ) {
    super(reason);
  }
}

export type HttpFetch = typeof fetch;

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export const STATE_TTL_SECONDS = 600;
const TIMEOUT_MS = 10_000;
const MAX_ACCESS_TOKEN_LENGTH = 2048;
const PROVIDER_ERROR = /^[A-Za-z0-9_.-]{1,64}$/;

const ENDPOINTS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    extra: { prompt: "select_account" },
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    extra: { allow_signup: "true" },
  },
} as const;

export function enabledProviders(settings: OAuthSettings): OAuthProviderId[] {
  return OAUTH_PROVIDERS.filter((provider) => settings[provider]);
}

export function redirectUri(
  settings: OAuthSettings,
  provider: OAuthProviderId,
): string {
  return `${settings.redirectOrigin}/dashboard/v1/auth/oauth/${provider}/callback`;
}

const sign = (secret: string, value: string) =>
  createHmac("sha256", secret).update(`oauth:${value}`).digest("base64url");

const pkceVerifier = (secret: string, state: string) =>
  createHmac("sha256", secret).update(`pkce:${state}`).digest("base64url");

export function startAuthorization(
  settings: OAuthSettings,
  secret: string,
  provider: OAuthProviderId,
  now = Date.now(),
): { url: string; stateCookie: string } {
  const client = settings[provider]!;
  const endpoints = ENDPOINTS[provider];
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(pkceVerifier(secret, state))
    .digest("base64url");
  const url = new URL(endpoints.authorize);
  for (const [name, value] of Object.entries({
    client_id: client.clientId,
    redirect_uri: redirectUri(settings, provider),
    response_type: "code",
    scope: endpoints.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...endpoints.extra,
  })) {
    url.searchParams.set(name, value);
  }
  const expires = Math.floor(now / 1000) + STATE_TTL_SECONDS;
  const payload = `${provider}.${state}.${expires}`;
  return {
    url: url.toString(),
    stateCookie: `${payload}.${sign(secret, payload)}`,
  };
}

export function stateMatches(
  secret: string,
  provider: OAuthProviderId,
  cookie: string | undefined,
  state: string | undefined,
  now = Date.now(),
): boolean {
  if (!cookie || !state) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4) return false;
  const [cookieProvider, cookieState, expires, mac] = parts as [
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(
    sign(secret, `${cookieProvider}.${cookieState}.${expires}`),
  );
  const given = Buffer.from(mac);
  const sameState = Buffer.from(cookieState);
  const askedState = Buffer.from(state);
  return (
    given.length === expected.length &&
    timingSafeEqual(given, expected) &&
    cookieProvider === provider &&
    Number(expires) * 1000 > now &&
    sameState.length === askedState.length &&
    timingSafeEqual(sameState, askedState)
  );
}

function providerErrorOf(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && PROVIDER_ERROR.test(error)
    ? error
    : undefined;
}

async function json(response: Response, step: OAuthStep): Promise<unknown> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new OAuthError("failed", {
      step,
      status: response.status,
      providerError: providerErrorOf(body),
    });
  }
  return response.json();
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 320
    ? value
    : undefined;

async function exchangeCode(
  settings: OAuthSettings,
  secret: string,
  provider: OAuthProviderId,
  code: string,
  state: string,
  http: HttpFetch,
): Promise<string> {
  const client = settings[provider]!;
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    redirect_uri: redirectUri(settings, provider),
    grant_type: "authorization_code",
    code_verifier: pkceVerifier(secret, state),
  });
  const response = await http(ENDPOINTS[provider].token, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = (await json(response, "token")) as {
    access_token?: unknown;
  };
  const accessToken = token.access_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_ACCESS_TOKEN_LENGTH
  ) {
    throw new OAuthError("failed", {
      step: "token",
      status: response.status,
      providerError: providerErrorOf(token),
    });
  }
  return accessToken;
}

async function getJson(
  http: HttpFetch,
  url: string,
  accessToken: string,
): Promise<unknown> {
  return json(
    await http(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "secure-cloud-platform",
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    "profile",
  );
}

async function googleProfile(
  http: HttpFetch,
  accessToken: string,
): Promise<OAuthProfile> {
  const info = (await getJson(
    http,
    "https://openidconnect.googleapis.com/v1/userinfo",
    accessToken,
  )) as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
  };
  const subject = text(info.sub);
  const email = text(info.email);
  if (!subject || !email) throw new OAuthError("failed", { step: "profile" });
  if (info.email_verified !== true) {
    throw new OAuthError("email_unverified", { step: "profile" });
  }
  return { subject, email, name: text(info.name) ?? null };
}

async function githubProfile(
  http: HttpFetch,
  accessToken: string,
): Promise<OAuthProfile> {
  const user = (await getJson(
    http,
    "https://api.github.com/user",
    accessToken,
  )) as { id?: unknown; name?: unknown; login?: unknown };
  const emails = await getJson(
    http,
    "https://api.github.com/user/emails",
    accessToken,
  );
  if (typeof user.id !== "number" || !Array.isArray(emails)) {
    throw new OAuthError("failed", { step: "profile" });
  }
  const primary = (
    emails as { email?: unknown; primary?: unknown; verified?: unknown }[]
  ).find((entry) => entry.primary === true && entry.verified === true);
  const email = text(primary?.email);
  if (!email) throw new OAuthError("email_unverified", { step: "profile" });
  return {
    subject: String(user.id),
    email,
    name: text(user.name) ?? text(user.login) ?? null,
  };
}

export async function fetchProfile(
  settings: OAuthSettings,
  secret: string,
  provider: OAuthProviderId,
  code: string,
  state: string,
  http: HttpFetch,
): Promise<OAuthProfile> {
  const accessToken = await exchangeCode(
    settings,
    secret,
    provider,
    code,
    state,
    http,
  );
  return provider === "google"
    ? googleProfile(http, accessToken)
    : githubProfile(http, accessToken);
}

const printable = (character: string) => {
  const code = character.charCodeAt(0);
  return code > 31 && code !== 127;
};

export function displayNameFrom(name: string | null): string | null {
  const cleaned = [...(name ?? "")]
    .filter(printable)
    .join("")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || null;
}
