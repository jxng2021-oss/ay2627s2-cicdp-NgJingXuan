import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  fail,
  GATEWAY_URL,
  LOCAL_OWNER_EMAIL,
  localAccount,
  OWNER_FILE,
  ownedWorkspace,
  requireLocalDevMode,
  saveOwner,
  savedOwnerPassword,
} from "./dashboard-session.ts";

requireLocalDevMode("The demo shop setup");

const ENV_FILE = ".local/demo-shop.env";
const PAYMENT_KEY =
  process.env.MOCK_PAYMENT_API_KEY ?? "local-demo-payment-key";
const PAYMENTS_URL = "http://mock-upstream:4000/api/payments";

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

async function v1(apiKey: string, method: string, path: string, body: unknown) {
  const response = await fetch(`${GATEWAY_URL}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    fail(
      `${method} /v1${path} answered ${response.status}: ${await response.text()}`,
    );
  }
}

const owner = await localAccount(
  LOCAL_OWNER_EMAIL,
  savedOwnerPassword(),
  "Demo Shop",
);
saveOwner(owner);
const session = owner.session;
const workspace = await ownedWorkspace(owner, "Demo Shop");
console.log(`• Shop owner ${owner.email}, workspace Demo Shop.`);

const keys = (await session.call("GET", `/workspaces/${workspace}/api-keys`))
  .apiKeys as { id: string; name: string; status: string }[];
for (const old of keys) {
  if (old.name === "demo-shop server" && old.status === "active") {
    await session.call("DELETE", `/workspaces/${workspace}/api-keys/${old.id}`);
  }
}
const created = await session.call(
  "POST",
  `/workspaces/${workspace}/api-keys`,
  {
    name: "demo-shop server",
  },
);
const apiKey = created.key;
if (typeof apiKey !== "string") fail("The API key wasn't returned.");

await v1(apiKey, "PUT", "/secrets/payment-api-key", { value: PAYMENT_KEY });
await v1(apiKey, "PUT", "/proxy-connections/payments", {
  baseUrl: PAYMENTS_URL,
  secretName: "payment-api-key",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  policy: {
    allowedRoutes: [{ method: "POST", path: "/charges" }],
    rateLimit: { requests: 20, windowSeconds: 60 },
    amountLimit: { field: "amount", maxPerRequest: 50_000, maxPerDay: 200_000 },
  },
});

const pools = (await session.call("GET", `/workspaces/${workspace}/user-pools`))
  .pools as { id: string; name: string }[];
const pool =
  pools.find((p) => p.name === "Shop customers") ??
  (await session.call("POST", `/workspaces/${workspace}/user-pools`, {
    name: "Shop customers",
    accessTokenTtlSeconds: 300,
  }));
const poolId = pool.id;
if (typeof poolId !== "string") fail("The user pool wasn't created.");

const flags = (await session.call("GET", `/workspaces/${workspace}/flags`))
  .flags as { key: string }[];
if (!flags.some((flag) => flag.key === "sale-banner")) {
  await session.call("POST", `/workspaces/${workspace}/flags`, {
    key: "sale-banner",
    description: "The demo shop's holiday sale banner",
    kind: "boolean",
    offValue: false,
  });
  await session.call(
    "PUT",
    `/workspaces/${workspace}/flags/sale-banner/environments/production`,
    { enabled: true, rules: [], defaultValue: true },
  );
}

mkdirSync(".local", { recursive: true });
const adminPassword =
  /^SHOP_ADMIN_PASSWORD=(.+)$/m.exec(
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "",
  )?.[1] ?? random(18);
writeFileSync(
  ENV_FILE,
  `# Written by pnpm demo:setup. LOCAL ONLY; never commit.\nPLATFORM_API_KEY=${apiKey}\nPLATFORM_POOL_ID=${poolId}\nSHOP_ADMIN_PASSWORD=${adminPassword}\n`,
  { mode: 0o600 },
);

const restarted = spawnSync(
  "docker",
  [
    "compose",
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "demo-shop",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
if (restarted.status !== 0) fail("Couldn't restart the demo-shop container.");

console.log("✔ The demo shop is connected to the platform.");
console.log("  Shop:      http://localhost:3100");
console.log(
  `  Admin:     http://localhost:3100/admin  (SHOP_ADMIN_PASSWORD in ${ENV_FILE})`,
);
console.log(
  `  Dashboard: http://localhost:3000  (the shop owner's login is in ${OWNER_FILE})`,
);
