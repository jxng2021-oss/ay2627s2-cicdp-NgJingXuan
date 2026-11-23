import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import {
  auditContract,
  flagsContract,
  identityContract,
  secretsContract,
  serviceError,
  startContractService,
  startContractStorage,
  type ReceivedRequest,
  type ServiceReply,
} from "./contract-helpers.js";
import { AUDIT_TOKEN, DASHBOARD_ORIGIN } from "./helpers.js";

export const PASSWORD = `test-${randomUUID()}`;
export const COOKIE = "__Secure-scp_session";
export const REFRESH_COOKIE = "__Secure-scp_refresh";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class Browser {
  cookie: string | undefined;
  refresh: string | undefined;
  csrf: string | undefined;
  lastSetCookies: string[] = [];

  constructor(private readonly app: FastifyInstance) {}

  async request(
    method: Method,
    url: string,
    options: {
      body?: unknown;
      raw?: Buffer;
      headers?: Record<string, string>;
      csrf?: boolean;
      origin?: string | null;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const origin =
      options.origin === undefined ? DASHBOARD_ORIGIN : options.origin;
    const headers: Record<string, string> = {
      ...(origin === null ? {} : { origin }),
      ...(this.cookieHeader() ? { cookie: this.cookieHeader()! } : {}),
      ...(options.csrf !== false && this.csrf && method !== "GET"
        ? { "x-csrf-token": this.csrf }
        : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    };
    const response = await this.app.inject({
      method,
      url,
      headers,
      payload:
        options.raw ??
        (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const setCookie = response.headers["set-cookie"];
    const set = setCookie === undefined ? [] : [setCookie].flat();
    if (set.length > 0) this.lastSetCookies = set;
    for (const line of set) {
      const [, name, value] = /^([^=]+)=([^;]*)/.exec(line) ?? [];
      if (name === COOKIE) this.cookie = value || undefined;
      if (name === REFRESH_COOKIE) this.refresh = value || undefined;
    }
    return response;
  }

  cookieHeader(): string | undefined {
    const parts = [
      this.cookie ? `${COOKIE}=${this.cookie}` : undefined,
      this.refresh ? `${REFRESH_COOKIE}=${this.refresh}` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  async refreshCsrf(): Promise<void> {
    const response = await this.request("GET", "/dashboard/v1/auth/csrf");
    this.csrf = response.json<{ csrfToken: string }>().csrfToken;
  }

  async signUp(email: string, workspaceName = "Acme"): Promise<string> {
    const response = await this.request("POST", "/dashboard/v1/auth/sign-up", {
      body: { email, password: PASSWORD, workspaceName },
    });
    expect(response.statusCode).toBe(201);
    await this.refreshCsrf();
    return response.json<{ workspaces: { id: string }[] }>().workspaces[0]!.id;
  }

  async login(email: string, password = PASSWORD) {
    const response = await this.request("POST", "/dashboard/v1/auth/login", {
      body: { email, password },
    });
    if (response.statusCode === 200) await this.refreshCsrf();
    return response;
  }

  ws(workspaceId: string, path = "") {
    return `/dashboard/v1/workspaces/${workspaceId}${path}`;
  }
}

export async function fakeSecrets() {
  const values = new Map<string, string>();
  const shredded = new Set<string>();
  const state = { sealed: false };
  const key = (req: ReceivedRequest, name: string) =>
    `${String(req.headers["x-tenant-id"])}/${name}`;
  const noStore = { "cache-control": "no-store" };
  const json = (status: number, body: unknown): ServiceReply => ({
    status,
    contentType: "application/json",
    headers: noStore,
    body: JSON.stringify(body),
  });
  const now = "2026-11-05T09:30:00.000Z";
  const service = await startContractService(secretsContract, (req) => {
    const path = req.url.split("?")[0]!;
    if (path === "/ready") {
      return {
        status: state.sealed ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: state.sealed ? "not_ready" : "ready",
          checks: {
            postgres: "up",
            seal: state.sealed ? "sealed" : "unsealed",
          },
        }),
      };
    }
    const tenant = String(req.headers["x-tenant-id"]);
    if (state.sealed) return serviceError(req, 503, "SECRETS_SEALED", noStore);
    if (path === "/internal/tenant" && req.method === "DELETE") {
      for (const k of [...values.keys()]) {
        if (k.startsWith(`${tenant}/`)) values.delete(k);
      }
      shredded.add(tenant);
      return { status: 204, headers: noStore };
    }
    if (path === "/secrets" && req.method === "GET") {
      const secrets = [...values.keys()]
        .filter((k) => k.startsWith(`${tenant}/`))
        .map((k) => ({
          name: k.slice(tenant.length + 1),
          latestVersion: 1,
          createdAt: now,
          updatedAt: now,
        }));
      return json(200, { secrets, nextCursor: null });
    }
    const match = /^\/secrets\/([^/]+)(\/rotate|\/versions)?$/.exec(path);
    if (!match) return serviceError(req, 404, "NOT_FOUND", noStore);
    const name = decodeURIComponent(match[1]!);
    const exists = values.has(key(req, name));
    if (req.method === "PUT") {
      values.set(
        key(req, name),
        (JSON.parse(req.body.toString()) as { value: string }).value,
      );
      return json(exists ? 200 : 201, { name, version: 1, createdAt: now });
    }
    if (!exists) return serviceError(req, 404, "NOT_FOUND", noStore);
    if (match[2] === "/rotate") {
      values.set(
        key(req, name),
        (JSON.parse(req.body.toString()) as { value: string }).value,
      );
      return json(200, { name, version: 2, createdAt: now });
    }
    if (match[2] === "/versions") {
      return json(200, {
        name,
        versions: [{ version: 1, createdAt: now }],
        nextCursor: null,
      });
    }
    if (req.method === "DELETE") {
      values.delete(key(req, name));
      return { status: 204, headers: noStore };
    }
    return serviceError(req, 404, "NOT_FOUND", noStore);
  });
  return { ...service, values, shredded, state };
}

export async function fakeStorage() {
  const files = new Map<string, { tenant: string; body: Buffer }>();
  const state = { failTenantDelete: false };
  const service = await startContractStorage((req, body) => {
    const tenant = String(req.headers["x-tenant-id"]);
    const path = req.url.split("?")[0]!;
    const meta = (id: string, size: number) => ({
      id,
      size,
      name: null,
      contentType: "application/octet-stream",
      createdAt: "2026-11-05T09:30:00.000Z",
    });
    const json = (status: number, payload: unknown): ServiceReply => ({
      status,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
    if (path === "/files" && req.method === "POST") {
      const id = randomUUID();
      files.set(id, { tenant, body });
      return json(201, meta(id, body.length));
    }
    if (path === "/files") {
      const mine = [...files].filter(([, f]) => f.tenant === tenant);
      return json(200, {
        files: mine.map(([id, f]) => meta(id, f.body.length)),
        nextCursor: null,
      });
    }
    if (path === "/usage")
      return json(200, { usedBytes: 0, reservedBytes: 0, limitBytes: 1000 });
    if (path === "/tenant" && req.method === "DELETE") {
      if (state.failTenantDelete)
        return serviceError(req, 500, "INTERNAL_ERROR");
      for (const [id, f] of [...files])
        if (f.tenant === tenant) files.delete(id);
      return { status: 204 };
    }
    const match = /^\/files\/([^/]+)(\/metadata)?$/.exec(path);
    const file = match ? files.get(match[1]!) : undefined;
    if (!file || file.tenant !== tenant)
      return serviceError(req, 404, "NOT_FOUND");
    if (req.method === "DELETE") {
      files.delete(match![1]!);
      return { status: 204 };
    }
    if (match![2]) return json(200, meta(match![1]!, file.body.length));
    return {
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "content-disposition": 'attachment; filename="f"',
        "x-content-type-options": "nosniff",
      },
      body: file.body,
    };
  });
  return { ...service, files, state };
}

export function fakeAuditEvents(
  summary: (url: string) => unknown = () => ({ daily: [], connections: [] }),
) {
  return startContractService(
    auditContract,
    (request) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        request.url.startsWith("/events/summary")
          ? summary(request.url)
          : { events: [], nextCursor: null },
      ),
    }),
    `Bearer ${AUDIT_TOKEN}`,
  );
}

export async function fakeIdentity() {
  const pools = new Map<string, { tenantId: string; name: string }>();
  const deletedTenants = new Set<string>();
  const state = { failing: false };
  const json = (status: number, body: unknown): ServiceReply => ({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
  const poolJson = (id: string, name: string) => ({
    id,
    name,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    minPasswordLength: 12,
    userCount: 0,
    issuer: `https://api.example.test/v1/user-pools/${id}`,
    jwksUrl: `https://api.example.test/v1/user-pools/${id}/jwks.json`,
    createdAt: new Date().toISOString(),
  });
  const user = {
    id: randomUUID(),
    email: "ada@example.com",
    status: "active",
    locked: false,
    passwordResetRequired: false,
    attributes: {},
    roles: [] as string[],
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  const roles = new Map<
    string,
    Map<string, { description: string; permissions: string[] }>
  >();
  const roleJson = (
    name: string,
    role: { description: string; permissions: string[] },
  ) => ({
    name,
    description: role.description,
    permissions: role.permissions,
    userCount: user.roles.includes(name) ? 1 : 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const service = await startContractService(identityContract, (request) => {
    if (state.failing) {
      return serviceError(request, 503, "SERVICE_UNAVAILABLE");
    }
    const tenant = String(request.headers["x-tenant-id"] ?? "");
    const path = request.url.split("?")[0]!;
    const body = request.body.length
      ? (JSON.parse(request.body.toString()) as Record<string, unknown>)
      : {};
    if (path.startsWith("/public/pools/")) {
      const id = path.split("/")[3]!;
      if (!pools.has(id)) return serviceError(request, 404, "NOT_FOUND");
      return {
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "public, max-age=300" },
        body: JSON.stringify({ keys: [] }),
      };
    }
    if (path === "/tenant" && request.method === "DELETE") {
      deletedTenants.add(tenant);
      for (const [id, pool] of pools)
        if (pool.tenantId === tenant) pools.delete(id);
      return { status: 204, headers: { "cache-control": "no-store" } };
    }
    if (path === "/pools" && request.method === "GET") {
      return json(200, {
        pools: [...pools]
          .filter(([, p]) => p.tenantId === tenant)
          .map(([id, p]) => poolJson(id, p.name)),
      });
    }
    if (path === "/pools" && request.method === "POST") {
      const id = randomUUID();
      pools.set(id, { tenantId: tenant, name: String(body.name) });
      return json(201, poolJson(id, String(body.name)));
    }
    const [, , poolId, sub, , action] = path.split("/");
    const pool = pools.get(poolId ?? "");
    if (!pool || pool.tenantId !== tenant) {
      return serviceError(request, 404, "NOT_FOUND");
    }
    if (!sub) {
      if (request.method === "DELETE") {
        pools.delete(poolId!);
        return { status: 204, headers: { "cache-control": "no-store" } };
      }
      return json(200, poolJson(poolId!, pool.name));
    }
    if (sub === "sessions") {
      if (path.endsWith("/revoke")) {
        return { status: 204, headers: { "cache-control": "no-store" } };
      }
      return json(200, {
        accessToken: "header.payload.signature",
        tokenType: "Bearer",
        expiresIn: 900,
        refreshToken: "r".repeat(43),
        passwordResetRequired: user.passwordResetRequired,
        user,
      });
    }
    if (sub === "roles") {
      type FakeRole = { description: string; permissions: string[] };
      const poolRoles: Map<string, FakeRole> =
        roles.get(poolId!) ?? new Map<string, FakeRole>();
      roles.set(poolId!, poolRoles);
      const name = path.split("/")[4];
      if (!name) {
        if (request.method === "GET") {
          return json(200, {
            roles: [...poolRoles].map(([n, r]) => roleJson(n, r)),
          });
        }
        if (poolRoles.has(String(body.name)))
          return serviceError(request, 409, "CONFLICT");
        const role: FakeRole = {
          description:
            typeof body.description === "string" ? body.description : "",
          permissions: Array.isArray(body.permissions)
            ? body.permissions.map(String)
            : [],
        };
        poolRoles.set(String(body.name), role);
        return json(201, roleJson(String(body.name), role));
      }
      const role = poolRoles.get(name);
      if (!role) return serviceError(request, 404, "NOT_FOUND");
      if (request.method === "DELETE") {
        poolRoles.delete(name);
        return { status: 204, headers: { "cache-control": "no-store" } };
      }
      if (request.method === "PATCH") {
        if (typeof body.description === "string")
          role.description = body.description;
        if (Array.isArray(body.permissions))
          role.permissions = body.permissions.map(String);
      }
      return json(200, roleJson(name, role));
    }
    if (sub === "users" && action === "roles") {
      const name = path.split("/")[6]!;
      if (!roles.get(poolId!)?.has(name))
        return serviceError(request, 404, "NOT_FOUND");
      user.roles = user.roles.filter((r) => r !== name);
      if (request.method === "PUT") user.roles.push(name);
      return json(200, user);
    }
    if (sub === "users") {
      if (action === "reset-password") {
        return json(200, { ...user, passwordResetRequired: true });
      }
      if (action === "unlock") {
        return json(200, { ...user, locked: false });
      }
      if (action === "password" || request.method === "DELETE") {
        return { status: 204, headers: { "cache-control": "no-store" } };
      }
      if (request.method === "GET" && path.endsWith("/users")) {
        return json(200, { users: [user], nextCursor: null });
      }
      return json(request.method === "POST" ? 201 : 200, user);
    }
    return serviceError(request, 404, "NOT_FOUND");
  });
  return { ...service, pools, roles, user, deletedTenants, state };
}

export async function fakeFlags() {
  const flags = new Map<
    string,
    { tenantId: string; flag: Record<string, unknown> }
  >();
  const deletedTenants = new Set<string>();
  const state = { failing: false };
  const json = (status: number, body: unknown): ServiceReply => ({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
  const off = { enabled: false, rules: [], defaultValue: false };
  const service = await startContractService(flagsContract, (request) => {
    if (state.failing) return serviceError(request, 503, "SERVICE_UNAVAILABLE");
    const tenant = String(request.headers["x-tenant-id"] ?? "");
    const path = request.url.split("?")[0]!;
    const body = request.body.length
      ? (JSON.parse(request.body.toString()) as Record<string, unknown>)
      : {};
    if (path === "/tenant") {
      deletedTenants.add(tenant);
      for (const [id, entry] of flags)
        if (entry.tenantId === tenant) flags.delete(id);
      return { status: 204, headers: { "cache-control": "no-store" } };
    }
    if (path === "/evaluate") {
      const values: Record<string, unknown> = {};
      for (const entry of flags.values()) {
        if (entry.tenantId === tenant) {
          values[String(entry.flag.key)] = { value: false, reason: "off" };
        }
      }
      return json(200, { environment: body.environment, flags: values });
    }
    if (path === "/flags" && request.method === "GET") {
      return json(200, {
        flags: [...flags.values()]
          .filter((e) => e.tenantId === tenant)
          .map((e) => e.flag),
      });
    }
    if (path === "/flags" && request.method === "POST") {
      const now = new Date().toISOString();
      const flag = {
        key: body.key,
        description: body.description ?? "",
        kind: body.kind,
        offValue: body.offValue,
        environments: { development: off, staging: off, production: off },
        createdAt: now,
        updatedAt: now,
      };
      flags.set(`${tenant}/${String(body.key)}`, { tenantId: tenant, flag });
      return json(201, flag);
    }
    const key = path.split("/")[2] ?? "";
    const entry = flags.get(`${tenant}/${key}`);
    if (!entry) return serviceError(request, 404, "NOT_FOUND");
    if (request.method === "DELETE") {
      flags.delete(`${tenant}/${key}`);
      return { status: 204, headers: { "cache-control": "no-store" } };
    }
    if (request.method === "PUT") {
      const environment = path.split("/")[4]!;
      entry.flag.environments = {
        ...(entry.flag.environments as object),
        [environment]: body,
      };
    }
    return json(200, entry.flag);
  });
  return { ...service, flags, deletedTenants, state };
}
