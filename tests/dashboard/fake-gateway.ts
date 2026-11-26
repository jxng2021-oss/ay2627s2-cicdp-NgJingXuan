import { vi } from "vitest";

export const WS = "11111111-1111-4111-8111-111111111111";
export const OTHER_WS = "99999999-9999-4999-8999-999999999999";
export const POOL = "22222222-2222-4222-8222-222222222222";
export const ADA = "33333333-3333-4333-8333-333333333333";
export const BOB = "44444444-4444-4444-8444-444444444444";
export const KEY_ID = "55555555-5555-4555-8555-555555555555";
export const OLD_KEY_ID = "66666666-6666-4666-8666-666666666666";
export const FILE_ID = "77777777-7777-4777-8777-777777777777";
export const HOOK = "88888888-8888-4888-8888-888888888888";
export const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const T = "2026-11-20T10:00:00.000Z";
export const T2 = "2026-11-24T15:30:00.000Z";

export type Role = "owner" | "member";

export const me = (role: Role = "owner") => ({
  user: {
    id: ADA,
    email: "ada@example.com",
    displayName: "Ada",
    createdAt: T,
    hasPassword: true,
  },
  workspaces: [
    { id: WS, name: "Acme shop", role },
    { id: OTHER_WS, name: "Side project", role: "member" as Role },
  ],
});

export const overview = (role: Role = "owner", sealed = false) => ({
  id: WS,
  name: "Acme shop",
  role,
  secretsCount: sealed ? null : 2,
  fileCount: 1,
  storage: {
    usedBytes: 2_400_000,
    reservedBytes: 0,
    limitBytes: 5_000_000_000,
  },
  secretsSealed: sealed,
});

const day = (d: string, n: number) => ({
  day: d,
  succeeded: 10 * n,
  refused: n,
  failed: n % 2,
  filesUploaded: n,
  filesDownloaded: 2 * n,
  changes: n,
  signIns: 3 * n,
  failedSignIns: n,
});

const totals = (n: number) => ({
  succeeded: 10 * n,
  refused: n,
  failed: n % 2,
  filesUploaded: n,
  filesDownloaded: 2 * n,
  changes: n,
  signIns: 3 * n,
  failedSignIns: n,
});

export const analytics = (range = "7d") => ({
  range,
  firstDay: "2026-11-18",
  lastDay: "2026-11-24",
  daily: [
    day("2026-11-18", 1),
    day("2026-11-19", 2),
    day("2026-11-20", 0),
    day("2026-11-21", 3),
    day("2026-11-22", 4),
    day("2026-11-23", 2),
    day("2026-11-24", 5),
  ],
  totals: totals(17),
  previous: totals(9),
  connections: [{ name: "stripe", succeeded: 12, refused: 2, failed: 1 }],
});

export const apiKeys = () => ({
  apiKeys: [
    {
      id: KEY_ID,
      name: "shop-server",
      prefix: "sk_live_ab12",
      status: "active",
      createdAt: T,
      revokedAt: null,
      lastUsedAt: T2,
    },
    {
      id: OLD_KEY_ID,
      name: "old-key",
      prefix: "sk_live_cd34",
      status: "revoked",
      createdAt: T,
      revokedAt: T2,
      lastUsedAt: null,
    },
  ],
});

export const secrets = () => ({
  secrets: [
    {
      name: "stripe-secret-key",
      latestVersion: 2,
      createdAt: T,
      updatedAt: T2,
    },
    { name: "webhook-secret", latestVersion: 1, createdAt: T, updatedAt: T },
  ],
  nextCursor: "next-page",
});

export const secretVersions = () => ({
  name: "stripe-secret-key",
  versions: [
    { version: 1, createdAt: T },
    { version: 2, createdAt: T2 },
  ],
  nextCursor: null,
});

export const file = () => ({
  id: FILE_ID,
  size: 412_000,
  name: "product-mug.jpg",
  contentType: "image/jpeg",
  createdAt: T,
});

export const files = () => ({
  files: [
    file(),
    {
      id: "78787878-7878-4787-8787-787878787878",
      size: 96_000,
      name: null,
      contentType: "application/pdf",
      createdAt: T2,
    },
  ],
  nextCursor: "next-page",
});

export const usage = (usedBytes = 2_400_000) => ({
  usedBytes,
  reservedBytes: 0,
  limitBytes: 5_000_000_000,
});

export const connection = (withPolicy = true) => ({
  name: "stripe",
  baseUrl: "https://api.stripe.com/v1",
  secretName: "stripe-secret-key",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  ...(withPolicy
    ? {
        policy: {
          allowedRoutes: [
            { method: "POST" as const, path: "/payment_intents" },
            { method: "GET" as const, path: "/payment_intents/*" },
          ],
          rateLimit: { requests: 100, windowSeconds: 60 },
          amountLimit: {
            field: "amount",
            maxPerRequest: 50_000,
            maxPerDay: 500_000,
          },
        },
      }
    : {}),
  createdAt: T,
  updatedAt: T2,
});

export const connections = () => ({
  connections: [
    connection(true),
    {
      ...connection(false),
      name: "mailer",
      baseUrl: "https://api.mailer.test",
    },
  ],
});

export const connectionUsage = () => ({
  name: "stripe",
  day: "2026-11-24",
  calls: { used: 12, limit: 100, windowSeconds: 60, resetSeconds: 30 },
  amount: {
    field: "amount",
    usedToday: 120_000,
    maxPerDay: 500_000,
    maxPerRequest: 50_000,
  },
});

export const sessions = () => ({
  sessions: [
    {
      id: SESSION,
      createdAt: T,
      lastUsedAt: T2,
      expiresAt: "2026-12-20T10:00:00.000Z",
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0",
      current: true,
    },
    {
      id: OTHER_SESSION,
      createdAt: T,
      lastUsedAt: T,
      expiresAt: "2026-12-20T10:00:00.000Z",
      ip: null,
      userAgent: null,
      current: false,
    },
  ],
});

export const webhooks = () => ({
  endpoints: [
    {
      id: HOOK,
      name: "shop-payments",
      provider: "stripe",
      signingSecretName: "webhook-secret",
      forwardUrl: "https://shop.example.com/hooks/stripe",
      stripeUrl: `https://api.example.com/v1/webhooks/${HOOK}`,
      createdAt: T,
    },
  ],
});

export const webhookEvents = () => ({
  events: [
    {
      id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
      event: "payment.succeeded",
      providerEventId: "evt_1",
      orderId: "order-42",
      amount: 2500,
      currency: "sgd",
      paymentId: "pi_1",
      reason: null,
      occurredAt: T,
      receivedAt: T,
      deliveryStatus: "delivered",
      attempts: 1,
      lastError: null,
      deliveredAt: T,
    },
    {
      id: "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2",
      event: "payment.failed",
      providerEventId: "evt_2",
      orderId: null,
      amount: null,
      currency: null,
      paymentId: null,
      reason: "card_declined",
      occurredAt: T2,
      receivedAt: T2,
      deliveryStatus: "failed",
      attempts: 3,
      lastError: "forward URL answered 500",
      deliveredAt: null,
    },
  ],
});

export const pool = () => ({
  id: POOL,
  name: "Shop customers",
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  minPasswordLength: 12,
  userCount: 2,
  issuer: `https://api.example.com/v1/user-pools/${POOL}`,
  jwksUrl: `https://api.example.com/v1/user-pools/${POOL}/.well-known/jwks.json`,
  createdAt: T,
});

export const poolUser = (
  id = BOB,
  email = "bob@example.com",
  extra: Record<string, unknown> = {},
) => ({
  id,
  email,
  status: "active",
  locked: false,
  passwordResetRequired: false,
  attributes: { plan: "pro" },
  roles: ["editor"],
  createdAt: T,
  lastLoginAt: T2,
  ...extra,
});

export const poolUsers = () => ({
  users: [
    poolUser(),
    poolUser(ADA, "ada@example.com", {
      status: "disabled",
      locked: true,
      roles: [],
      attributes: {},
      lastLoginAt: null,
    }),
  ],
  nextCursor: "next-page",
});

export const poolRoles = () => ({
  roles: [
    {
      name: "editor",
      description: "Can edit products",
      permissions: ["products:write", "products:read"],
      userCount: 1,
      createdAt: T,
      updatedAt: T2,
    },
    {
      name: "viewer",
      description: "",
      permissions: ["products:read"],
      userCount: 0,
      createdAt: T,
      updatedAt: T,
    },
  ],
});

const env = (enabled: boolean, extra: Record<string, unknown> = {}) => ({
  enabled,
  rules: [],
  defaultValue: false,
  ...extra,
});

export const flag = (key = "new-checkout") => ({
  key,
  description: "The new checkout flow",
  kind: "boolean",
  offValue: false,
  environments: {
    development: env(true, {
      rules: [
        {
          conditions: [
            { attribute: "plan", operator: "in", values: ["pro", "team"] },
          ],
          value: true,
          percentage: 50,
        },
      ],
      rollout: { percentage: 25, value: true },
      defaultValue: false,
    }),
    staging: env(false),
    production: env(true, { defaultValue: true }),
  },
  createdAt: T,
  updatedAt: T2,
});

export const stringFlag = () => ({
  ...flag("banner-text"),
  description: "",
  kind: "string",
  offValue: "",
  environments: {
    development: env(true, { defaultValue: "Hello" }),
    staging: env(false, { defaultValue: "" }),
    production: env(false, { defaultValue: "" }),
  },
});

export const flags = () => ({ flags: [flag(), stringFlag()] });

export const auditEvent = (
  action: string,
  outcome = "success",
  extra: Record<string, unknown> = {},
) => ({
  id: crypto.randomUUID(),
  occurredAt: T2,
  actorType: "user",
  actorId: ADA,
  action,
  resourceType:
    action.split(".")[0] === "proxy_connection" ? "proxy_connection" : "secret",
  resourceId: "stripe-secret-key",
  outcome,
  requestId: REQUEST_ID,
  sourceIp: "203.0.113.7",
  ...extra,
});

export const auditEvents = () => ({
  events: [
    auditEvent("secret.rotated"),
    auditEvent("proxy_connection.denied", "denied", {
      actorType: "api_key",
      actorId: KEY_ID,
      resourceId: "stripe",
    }),
    auditEvent("secret.created", "failure", {
      actorId: null,
      resourceId: null,
      requestId: null,
      sourceIp: null,
    }),
  ],
  nextCursor: "next-page",
});

export const poolAuditEvents = () => ({
  events: [
    auditEvent("pool_user.logged_in", "success", {
      actorType: "api_key",
      resourceType: "pool_user",
      resourceId: BOB,
    }),
    auditEvent("pool_user.login_failed", "denied", {
      actorType: "api_key",
      resourceType: "pool_user",
      resourceId: ADA,
    }),
  ],
  nextCursor: null,
});

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Answer = { status?: number; body?: unknown } | undefined;
type Handler = (call: Call, match: RegExpMatchArray) => unknown;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export const apiError = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message, requestId: REQUEST_ID } },
});

const W = `/dashboard/v1/workspaces/${WS}`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class FakeGateway {
  readonly calls: Call[] = [];
  private routes: Route[] = [];
  role: Role = "owner";
  sealed = false;

  constructor() {
    this.defaults();
  }

  on(method: string, path: string | RegExp, handler: Handler): this {
    const pattern =
      typeof path === "string"
        ? new RegExp(`^${escape(path).replace(/\\\{\\\*\\\}/g, "([^/]+)")}$`)
        : path;
    this.routes.unshift({ method, pattern, handler });
    return this;
  }

  ws(method: string, path: string, handler: Handler): this {
    return this.on(method, `${W}${path}`, handler);
  }

  fail(
    method: string,
    path: string,
    status = 500,
    code = "INTERNAL_ERROR",
    message = "Something went wrong",
  ): this {
    return this.ws(method, path, () => apiError(status, code, message));
  }

  called(method: string, path: string): Call[] {
    return this.calls.filter(
      (call) => call.method === method && call.path === `${W}${path}`,
    );
  }

  private defaults(): void {
    const ok = (body: unknown) => () => ({ status: 200, body });
    const none = () => ({ status: 204 });
    this.on("GET", "/dashboard/v1/auth/csrf", ok({ csrfToken: "csrf-1" }));
    this.on("GET", "/dashboard/v1/auth/me", () => ({
      status: 200,
      body: me(this.role),
    }));
    this.on("GET", "/dashboard/v1/auth/oauth/providers", ok({ providers: [] }));
    this.on("POST", "/dashboard/v1/auth/logout", none);
    this.on("POST", "/dashboard/v1/auth/logout-all", none);
    this.on("POST", "/dashboard/v1/auth/change-password", none);
    this.on("PATCH", "/dashboard/v1/account/profile", (call) => ({
      status: 200,
      body: {
        ...me(this.role),
        user: { ...me().user, ...(call.body as object) },
      },
    }));
    this.on("GET", "/dashboard/v1/account/sessions", ok(sessions()));
    this.on("DELETE", "/dashboard/v1/account/sessions/{*}", none);
    this.on("POST", "/dashboard/v1/account/delete", none);
    this.on("POST", "/dashboard/v1/workspaces", (call) => ({
      status: 201,
      body: {
        id: OTHER_WS,
        name: (call.body as { name: string }).name,
        role: "owner",
      },
    }));
    this.on("GET", W, () => ({
      status: 200,
      body: overview(this.role, this.sealed),
    }));
    this.on("DELETE", W, none);
    this.ws("DELETE", "/membership", none);
    this.ws("GET", "/analytics", (call) => ({
      status: 200,
      body: analytics(call.query.get("range") ?? "7d"),
    }));
    this.ws("GET", "/api-keys", ok(apiKeys()));
    this.ws("POST", "/api-keys", (call) => ({
      status: 201,
      body: {
        ...apiKeys().apiKeys[0],
        name: (call.body as { name: string }).name,
        key: "sk_live_the-full-new-key",
      },
    }));
    this.ws("DELETE", "/api-keys/{*}", none);
    this.ws("DELETE", "/revoked-api-keys/{*}", none);
    this.ws("GET", "/secrets", ok(secrets()));
    this.ws("PUT", "/secrets/{*}", ok({ name: "x", version: 1 }));
    this.ws("POST", "/secrets/{*}/rotate", ok({ name: "x", version: 3 }));
    this.ws("DELETE", "/secrets/{*}", none);
    this.ws("GET", "/secrets/{*}/versions", ok(secretVersions()));
    this.ws("GET", "/files", ok(files()));
    this.ws("GET", "/usage", ok(usage()));
    this.ws("GET", "/files/{*}/metadata", ok(file()));
    this.ws("DELETE", "/files/{*}", none);
    this.ws("GET", "/proxy-connections", ok(connections()));
    this.ws("PUT", "/proxy-connections/{*}", ok(connection()));
    this.ws("DELETE", "/proxy-connections/{*}", none);
    this.ws("GET", "/proxy-connections/{*}/usage", ok(connectionUsage()));
    this.ws("GET", "/webhooks", ok(webhooks()));
    this.ws("POST", "/webhooks", (call) => ({
      status: 201,
      body: { ...webhooks().endpoints[0], ...(call.body as object) },
    }));
    this.ws("DELETE", "/webhooks/{*}", none);
    this.ws("GET", "/webhooks/{*}/events", ok(webhookEvents()));
    this.ws("POST", "/webhooks/{*}/events/{*}/redeliver", none);
    this.ws("GET", "/user-pools", ok({ pools: [pool()] }));
    this.ws("POST", "/user-pools", (call) => ({
      status: 201,
      body: { ...pool(), ...(call.body as object) },
    }));
    this.ws("GET", "/user-pools/{*}", ok(pool()));
    this.ws("PATCH", "/user-pools/{*}", (call) => ({
      status: 200,
      body: { ...pool(), ...(call.body as object) },
    }));
    this.ws("DELETE", "/user-pools/{*}", none);
    this.ws("GET", "/user-pools/{*}/users", ok(poolUsers()));
    this.ws("GET", "/user-pools/{*}/users/{*}", (_call, match) => ({
      status: 200,
      body: match[2] === ADA ? poolUsers().users[1] : poolUser(),
    }));
    this.ws("PATCH", "/user-pools/{*}/users/{*}", (call) => ({
      status: 200,
      body: { ...poolUser(), ...(call.body as object) },
    }));
    this.ws("DELETE", "/user-pools/{*}/users/{*}", none);
    this.ws(
      "POST",
      "/user-pools/{*}/users/{*}/reset-password",
      ok({
        ...poolUser(),
        passwordResetRequired: true,
        temporaryPassword: "Temp-password-123456",
      }),
    );
    this.ws("POST", "/user-pools/{*}/users/{*}/unlock", ok(poolUser()));
    this.ws("PUT", "/user-pools/{*}/users/{*}/roles/{*}", ok(poolUser()));
    this.ws(
      "DELETE",
      "/user-pools/{*}/users/{*}/roles/{*}",
      ok({ ...poolUser(), roles: [] }),
    );
    this.ws("GET", "/user-pools/{*}/roles", ok(poolRoles()));
    this.ws("POST", "/user-pools/{*}/roles", (call) => ({
      status: 201,
      body: { ...poolRoles().roles[0], ...(call.body as object), userCount: 0 },
    }));
    this.ws("PATCH", "/user-pools/{*}/roles/{*}", ok(poolRoles().roles[0]));
    this.ws("DELETE", "/user-pools/{*}/roles/{*}", none);
    this.ws("GET", "/user-pools/{*}/audit-events", ok(poolAuditEvents()));
    this.ws("GET", "/flags", ok(flags()));
    this.ws("POST", "/flags", (call) => ({
      status: 201,
      body: {
        ...flag((call.body as { key: string }).key),
        ...(call.body as object),
      },
    }));
    this.ws("GET", "/flags/{*}", (_call, match) => ({
      status: 200,
      body:
        match[1] === "banner-text"
          ? stringFlag()
          : flag(decodeURIComponent(match[1]!)),
    }));
    this.ws("PUT", "/flags/{*}/environments/{*}", ok(flag()));
    this.ws("DELETE", "/flags/{*}", none);
    this.ws("POST", "/flags/evaluate", (call) => ({
      status: 200,
      body: {
        environment: (call.body as { environment: string }).environment,
        flags: {
          "new-checkout": { value: true, reason: "rule", ruleIndex: 0 },
          "banner-text": { value: "Hello", reason: "default" },
        },
      },
    }));
    this.ws("GET", "/audit-events", ok(auditEvents()));
  }

  readonly fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost:3000");
    const method = (init.method ?? "GET").toUpperCase();
    const body =
      typeof init.body === "string" && init.body
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
    };
    this.calls.push(call);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      const answer = (await route.handler(call, match)) as Answer;
      const status = answer?.status ?? 200;
      return new Response(
        status === 204 || answer?.body === undefined
          ? null
          : JSON.stringify(answer.body),
        { status, headers: { "x-request-id": REQUEST_ID } },
      );
    }
    return new Response(
      JSON.stringify({
        error: {
          code: "NOT_FOUND",
          message: "Not found",
          requestId: REQUEST_ID,
        },
      }),
      { status: 404 },
    );
  });

  install(): this {
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }
}
