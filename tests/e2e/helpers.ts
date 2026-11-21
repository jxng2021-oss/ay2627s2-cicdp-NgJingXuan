import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { dockerCompose } from "./operator.js";

export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
export const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN ?? "local-only-admin-token-do-not-use-elsewhere";
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const LIMITS = (() => {
  const file = readFileSync(new URL("e2e.env", import.meta.url), "utf8");
  const values = new Map(
    file
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=") as [string, string]),
  );
  const get = (name: string) => Number(process.env[name] ?? values.get(name));
  return {
    windowMs: get("RATE_LIMIT_WINDOW_MS"),
    requestsPerKey: get("RATE_LIMIT_REQUESTS_PER_KEY"),
    uploadsPerKey: get("RATE_LIMIT_UPLOADS_PER_KEY"),
    failedAuthPerIp: get("RATE_LIMIT_FAILED_AUTH_PER_IP"),
    adminPerIp: get("RATE_LIMIT_ADMIN_PER_IP"),
    maxUploadBytes: get("MAX_UPLOAD_BYTES"),
    maxSecretBytes: get("MAX_SECRET_BYTES"),
    sessionAccessTtlMs: get("SESSION_ACCESS_TTL_MS"),
  };
})();

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const freshWindow = () => sleep(LIMITS.windowMs + 300);

export async function admin(method: string, path: string, body?: object) {
  return fetch(`${GATEWAY_URL}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function createTenantWithKey(name: string) {
  const tenant = (await (await admin("POST", "/tenants", { name })).json()) as {
    id: string;
  };
  const created = await admin("POST", `/tenants/${tenant.id}/api-keys`, {
    name: `${name} key`,
  });
  expect(created.status).toBe(201);
  const { id: keyId, key } = (await created.json()) as {
    id: string;
    key: string;
  };
  return { tenantId: tenant.id, keyId, key };
}

export function upload(
  key: string,
  body: NonNullable<RequestInit["body"]>,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${GATEWAY_URL}/v1/storage/files`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/octet-stream",
      ...extraHeaders,
    },
    body,
    duplex: "half",
  });
}

export function download(
  id: string,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${GATEWAY_URL}/v1/storage/files/${id}`, {
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...extraHeaders,
    },
  });
}

export async function expectError(
  response: Response,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    error: { code: string; requestId: string };
  };
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  return body;
}

export function compose(...args: string[]): string {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed: ${result.stderr}`,
    );
  }
  return result.stdout + result.stderr;
}

export function secrets(
  key: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  value?: string,
) {
  return fetch(`${GATEWAY_URL}/v1/secrets${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(value === undefined ? {} : { "content-type": "application/json" }),
    },
    body: value === undefined ? undefined : JSON.stringify({ value }),
  });
}

export function psql(user: string, database: string, sql: string) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

export const SECRET_MARKER = "e2e-secret-value-";

export const FILE_CONTENT_MARKER = "e2e-file-content-";
export const FILE_NAME_MARKER = "e2e-file-name-";

export async function injectedValue(
  apiKey: string,
  secretName: string,
): Promise<string | undefined> {
  const saved = await fetch(`${GATEWAY_URL}/v1/proxy-connections/e2e-probe`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      baseUrl: "http://mock-upstream:4000/api",
      secretName,
      headerName: "X-Probe",
    }),
  });
  expect(saved.status).toBeLessThan(300);
  const called = await fetch(`${GATEWAY_URL}/v1/proxy/e2e-probe/record`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(called.status).toBe(200);
  const result = await dockerCompose([
    "exec",
    "-T",
    "mock-upstream",
    "node",
    "-e",
    "fetch('http://127.0.0.1:4000/__requests').then(r=>r.text()).then(console.log)",
  ]);
  const { requests } = JSON.parse(result.stdout) as {
    requests: { headers: Record<string, string> }[];
  };
  return requests.findLast((r) => r.headers["x-probe"] !== undefined)?.headers[
    "x-probe"
  ];
}
