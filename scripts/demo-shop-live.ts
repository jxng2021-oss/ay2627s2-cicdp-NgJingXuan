import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fail } from "./dashboard-session.ts";

export const LIVE_ENV_FILE = ".local/demo-shop-live.env";
const ENV_FILE = LIVE_ENV_FILE;
const DEFAULT_LIVE_API =
  process.env.DEMO_SHOP_LIVE_API_URL ?? "https://api.securee-cloud.duckdns.org";
const CONTAINER = "demo-shop-live";
const IMAGE = "secure-cloud-platform/demo-shop:dev";
const PORT = process.env.DEMO_SHOP_PORT ?? "3100";
const SHOP_URL = `http://localhost:${PORT}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function docker(args: string[], quiet = false) {
  const result = spawnSync("docker", args, {
    stdio: ["ignore", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

export function stopLive(): void {
  docker(["rm", "--force", CONTAINER], true);
}

function writeTemplate(): void {
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ENV_FILE,
    [
      "# Written by pnpm demo:start (DEMO_SHOP_TARGET=live). LOCAL ONLY; never commit.",
      "# The demo shop runs on this machine and uses the live platform's /v1 API.",
      `PLATFORM_API_URL=${DEFAULT_LIVE_API}`,
      "PLATFORM_API_KEY=",
      "PLATFORM_POOL_ID=",
      "# Optional: the Stripe webhook endpoint's ID (dashboard, Webhooks).",
      "PLATFORM_WEBHOOK_ENDPOINT_ID=",
      `SHOP_ADMIN_PASSWORD=${randomBytes(18).toString("base64url")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function readSettings(): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      settings.set(match[1], match[2].trim());
    }
  }
  return settings;
}

function apiUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    fail(`PLATFORM_API_URL in ${ENV_FILE} isn't a URL.`);
  }
  if (url.protocol !== "https:") {
    fail("PLATFORM_API_URL must start with https:// (the live platform).");
  }
  if (
    LOCAL_HOSTS.includes(url.hostname) ||
    url.hostname === "api.name.duckdns.org"
  ) {
    fail(
      `Set PLATFORM_API_URL in ${ENV_FILE} to your live API, e.g. https://api.myname.duckdns.org (for the local stack, use pnpm demo:setup).`,
    );
  }
  if (url.pathname !== "/" || url.search || url.username || url.password) {
    fail("PLATFORM_API_URL must be just the API's address, without a path.");
  }
  return url.origin;
}

function required(settings: Map<string, string>, name: string): string {
  const value = settings.get(name);
  if (!value)
    fail(`Fill in ${name} in ${ENV_FILE} (docs/demo-shop-targets.md).`);
  return value;
}

async function call(
  url: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail(`Couldn't reach ${url}. Is the server running?`);
  }
  const text = await response.text();
  try {
    return {
      status: response.status,
      data: text ? JSON.parse(text) : undefined,
    };
  } catch {
    return { status: response.status, data: undefined };
  }
}

function field(data: unknown, name: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[name]
    : undefined;
}

async function checkPlatform(
  url: string,
  key: string,
  poolId: string,
): Promise<void> {
  const ready = await call(url, key, "GET", "/ready");
  if (ready.status !== 200) fail(`${url}/ready answered ${ready.status}.`);
  console.log(`✔ The live platform at ${url} is ready.`);

  const connections = await call(url, key, "GET", "/v1/proxy-connections");
  if (connections.status === 401) {
    fail("The API key was refused: copy a new one from the live dashboard.");
  }
  if (connections.status !== 200) {
    fail(`GET /v1/proxy-connections answered ${connections.status}.`);
  }
  console.log("✔ The API key works.");

  const pool = await call(
    url,
    key,
    "GET",
    `/v1/user-pools/${poolId}/jwks.json`,
  );
  if (pool.status !== 200) {
    fail(
      "PLATFORM_POOL_ID doesn't match a user pool: copy its ID from the dashboard.",
    );
  }
  console.log("✔ The user pool exists (shop sign up and sign in).");

  const secret = await call(url, key, "GET", "/v1/secrets/stripe-secret-key");
  if (secret.status === 503) {
    fail("The live secrets service is sealed: unseal it on the server first.");
  }
  const list = field(connections.data, "connections");
  const hasStripe =
    Array.isArray(list) &&
    list.some((connection) => field(connection, "name") === "stripe");
  if (secret.status === 200 && hasStripe) {
    console.log("✔ The stripe-secret-key secret and stripe connection exist.");
  } else {
    console.log(
      "! No stripe-secret-key secret or stripe connection yet: checkout will fail until you add them (docs/demo-shop-targets.md, Live).",
    );
  }

  const flags = await call(url, key, "POST", "/v1/flags/evaluate", {
    environment: "production",
    context: { key: "demo-live-check" },
  });
  if (field(field(flags.data, "flags"), "sale-banner") === undefined) {
    console.log(
      "! No sale-banner flag in production yet: the sale banner stays hidden.",
    );
  } else {
    console.log("✔ The sale-banner flag exists.");
  }
}

function checkPortIsFree(): void {
  const using = docker(
    ["ps", "--filter", `publish=${PORT}`, "--format", "{{.Names}}"],
    true,
  )
    .stdout.split(/\r?\n/)
    .filter((name) => name && name !== CONTAINER);
  if (using.length > 0) {
    fail(
      `Port ${PORT} is used by ${using.join(", ")}: stop the local demo shop first (docker compose stop demo-shop).`,
    );
  }
}

async function waitForShop(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${SHOP_URL}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  docker(["logs", "--tail", "30", CONTAINER]);
  fail("The demo shop didn't start.");
}

export async function startLive(): Promise<void> {
  if (!existsSync(ENV_FILE)) {
    writeTemplate();
    fail(
      `Wrote ${ENV_FILE}: fill in your live API address, API key and user pool ID (docs/demo-shop-targets.md), then run pnpm demo:start again.`,
    );
  }
  const settings = readSettings();
  const url = apiUrl(settings.get("PLATFORM_API_URL"));
  const key = required(settings, "PLATFORM_API_KEY");
  const poolId = required(settings, "PLATFORM_POOL_ID");
  if (!UUID.test(poolId)) fail("PLATFORM_POOL_ID must be the pool's ID.");
  const endpointId = settings.get("PLATFORM_WEBHOOK_ENDPOINT_ID");
  if (endpointId && !UUID.test(endpointId)) {
    fail("PLATFORM_WEBHOOK_ENDPOINT_ID must be the webhook endpoint's ID.");
  }
  if (required(settings, "SHOP_ADMIN_PASSWORD").length < 12) {
    fail("SHOP_ADMIN_PASSWORD must be at least 12 characters.");
  }

  await checkPlatform(url, key, poolId);
  checkPortIsFree();

  console.log("• Building the demo shop image ...");
  if (docker(["compose", "build", "demo-shop"]).status !== 0) {
    fail("Couldn't build the demo shop image.");
  }
  stopLive();
  if (
    docker(["compose", "up", "--detach", "--wait", "demo-shop-db"]).status !== 0
  ) {
    fail("Couldn't start the demo shop's own database.");
  }
  const dbPassword =
    process.env.DEMO_SHOP_DB_PASSWORD ?? "local-only-demo-shop-db-password";
  const run = docker([
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--env-file",
    ENV_FILE,
    "--env",
    `PLATFORM_API_URL=${url}`,
    "--env",
    `SHOP_URL=${SHOP_URL}`,
    "--env",
    "PLATFORM_WEBHOOK_MODE=pull",
    "--env",
    `SHOP_DATABASE_URL=postgres://shop:${dbPassword}@demo-shop-db:5432/shop`,
    "--network",
    "demo-shop",
    "--publish",
    `127.0.0.1:${PORT}:3000`,
    IMAGE,
  ]);
  if (run.status !== 0) fail("Couldn't start the demo shop.");
  await waitForShop();

  console.log(`✔ The demo shop is running on this machine and using ${url}.`);
  console.log(`  Shop:      ${SHOP_URL}`);
  console.log(
    `  Admin:     ${SHOP_URL}/admin  (SHOP_ADMIN_PASSWORD in ${ENV_FILE})`,
  );
  console.log(`  Dashboard: ${url.replace("://api.", "://")}`);
  console.log("  Stop:      pnpm demo:stop");
}
