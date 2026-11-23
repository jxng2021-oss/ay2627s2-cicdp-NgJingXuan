import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fail, GATEWAY_URL } from "./dashboard-session.ts";
import { startLive, stopLive } from "./demo-shop-live.ts";

const LOCAL_ENV_FILE = ".local/demo-shop.env";
const TARGETS = ["local", "live"] as const;
type Target = (typeof TARGETS)[number];

function fromDotEnv(name: string): string | undefined {
  if (!existsSync(".env")) return undefined;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] === name) return match[2]?.trim();
  }
  return undefined;
}

function target(): Target {
  const value = (
    process.env.DEMO_SHOP_TARGET ??
    fromDotEnv("DEMO_SHOP_TARGET") ??
    "local"
  ).toLowerCase();
  if (!TARGETS.includes(value as Target)) {
    fail(`DEMO_SHOP_TARGET must be local or live, not "${value}".`);
  }
  return value as Target;
}

function compose(args: string[]): number {
  const result = spawnSync("docker", ["compose", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function startLocal(): Promise<void> {
  if (!existsSync(LOCAL_ENV_FILE)) {
    fail(
      `No ${LOCAL_ENV_FILE} yet: start the local stack (pnpm local:start), unseal it, then run LOCAL_DEV_MODE=true pnpm demo:setup.`,
    );
  }
  const ready = await fetch(`${GATEWAY_URL}/ready`).catch(() => undefined);
  if (ready?.status !== 200) {
    fail(
      `The local gateway at ${GATEWAY_URL} isn't ready: run pnpm local:start first.`,
    );
  }
  stopLive();
  if (
    compose([
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "demo-shop",
    ]) !== 0
  ) {
    fail("Couldn't start the local demo shop.");
  }
  const port = process.env.DEMO_SHOP_PORT ?? "3100";
  console.log(`✔ The demo shop is running and using ${GATEWAY_URL}.`);
  console.log(`  Shop:      http://localhost:${port}`);
  console.log(
    `  Admin:     http://localhost:${port}/admin  (SHOP_ADMIN_PASSWORD in ${LOCAL_ENV_FILE})`,
  );
  console.log("  Dashboard: http://localhost:3000");
  console.log("  Stop:      pnpm demo:stop");
}

function stopAll(): void {
  stopLive();
  compose(["stop", "demo-shop"]);
  console.log("✔ The demo shop is stopped.");
}

if (process.argv[2] === "stop") {
  stopAll();
} else {
  const chosen = target();
  console.log(`• DEMO_SHOP_TARGET=${chosen}`);
  if (chosen === "live") {
    compose(["stop", "demo-shop"]);
    await startLive();
  } else {
    await startLocal();
  }
}
