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
const WEBHOOK_SECRET_FILE = ".local/stripe-webhook-secret";
const SHOP_WEBHOOK_URL = "http://demo-shop:3000/webhooks/secure-cloud";

function fromDotEnv(name: string): string | undefined {
  if (!existsSync(".env")) return undefined;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] === name) return match[2]?.trim() || undefined;
  }
  return undefined;
}

const STRIPE_KEY =
  process.env.STRIPE_SECRET_KEY?.trim() || fromDotEnv("STRIPE_SECRET_KEY");
if (!STRIPE_KEY) {
  fail(
    "Set STRIPE_SECRET_KEY to your Stripe test secret key (Stripe dashboard, Test mode, Developers, API keys; it starts with sk_test_), in the root .env or the environment.",
  );
}
if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(STRIPE_KEY)) {
  fail(
    "STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_...). The demo shop never uses live keys.",
  );
}

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

const givenWebhookSecret =
  process.env.STRIPE_WEBHOOK_SECRET?.trim() ||
  fromDotEnv("STRIPE_WEBHOOK_SECRET");
if (
  givenWebhookSecret &&
  !/^whsec_[A-Za-z0-9]{10,}$/.test(givenWebhookSecret)
) {
  fail(
    "STRIPE_WEBHOOK_SECRET must be Stripe's webhook signing secret (whsec_...), from stripe listen or the Stripe dashboard.",
  );
}
const webhookSecret =
  givenWebhookSecret ??
  (existsSync(WEBHOOK_SECRET_FILE)
    ? readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim()
    : `whsec_local${randomBytes(24).toString("hex")}`);

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

await v1(apiKey, "PUT", "/secrets/stripe-secret-key", { value: STRIPE_KEY });
await v1(apiKey, "PUT", "/proxy-connections/stripe", {
  baseUrl: "https://api.stripe.com/v1",
  secretName: "stripe-secret-key",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  policy: {
    allowedRoutes: [
      { method: "POST", path: "/checkout/sessions" },
      { method: "GET", path: "/checkout/sessions/*" },
    ],
    rateLimit: { requests: 40, windowSeconds: 60 },
    amountLimit: {
      field: "line_items[0][price_data][unit_amount]",
      maxPerRequest: 50_000,
      maxPerDay: 200_000,
    },
  },
});
for (const old of ["/proxy-connections/payments", "/secrets/payment-api-key"]) {
  await fetch(`${GATEWAY_URL}/v1${old}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

await v1(apiKey, "PUT", "/secrets/stripe-webhook-secret", {
  value: webhookSecret,
});
const endpoints = (
  await session.call("GET", `/workspaces/${workspace}/webhooks`)
).endpoints as { id: string; name: string }[];
const existingEndpoint = endpoints.find((e) => e.name === "stripe");
const endpoint = existingEndpoint
  ? await session.call(
      "PATCH",
      `/workspaces/${workspace}/webhooks/${existingEndpoint.id}`,
      {
        signingSecretName: "stripe-webhook-secret",
        forwardUrl: SHOP_WEBHOOK_URL,
      },
    )
  : await session.call("POST", `/workspaces/${workspace}/webhooks`, {
      name: "stripe",
      signingSecretName: "stripe-webhook-secret",
      forwardUrl: SHOP_WEBHOOK_URL,
    });
const endpointId = endpoint.id;
if (typeof endpointId !== "string")
  fail("The webhook endpoint wasn't created.");

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
if (!givenWebhookSecret) {
  writeFileSync(WEBHOOK_SECRET_FILE, webhookSecret, { mode: 0o600 });
}
const adminPassword =
  /^SHOP_ADMIN_PASSWORD=(.+)$/m.exec(
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "",
  )?.[1] ?? random(18);
writeFileSync(
  ENV_FILE,
  `# Written by pnpm demo:setup. LOCAL ONLY; never commit.\nPLATFORM_API_KEY=${apiKey}\nPLATFORM_POOL_ID=${poolId}\nPLATFORM_WEBHOOK_ENDPOINT_ID=${endpointId}\nSHOP_ADMIN_PASSWORD=${adminPassword}\n`,
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
console.log(
  `  Webhooks:  stripe listen --forward-to ${GATEWAY_URL}/v1/webhooks/${endpointId}`,
);
if (!givenWebhookSecret) {
  console.log(
    "             then put the whsec_... it prints in .env as STRIPE_WEBHOOK_SECRET and run pnpm demo:setup again.",
  );
}
