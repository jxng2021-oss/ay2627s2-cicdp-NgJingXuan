import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SHARES_FILE = ".local/secrets-unseal-shares.json";

function localDevMode(): boolean {
  if (process.env.LOCAL_DEV_MODE !== undefined) {
    return process.env.LOCAL_DEV_MODE === "true";
  }
  if (!existsSync(".env")) return false;
  return /^LOCAL_DEV_MODE=true\s*$/m.test(readFileSync(".env", "utf8"));
}

function operator(
  args: string[],
  input = "",
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "secrets", "secrets-operator", ...args, "--json"],
    { input, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface Status {
  initialised: boolean;
  sealed: boolean;
  progress: number;
  threshold: number;
}

function status(): Status {
  const result = operator(["status"]);
  if (result.code !== 0) {
    console.error(
      "Could not reach the secrets service. Is the stack running? (pnpm local:start)",
    );
    console.error(result.stderr.trim());
    process.exit(1);
  }
  return JSON.parse(result.stdout) as Status;
}

function describe(s: Status): string {
  if (!s.initialised) return "not initialised";
  return s.sealed
    ? `sealed (${s.progress} of ${s.threshold} shares entered)`
    : "unsealed";
}

function unseal(): void {
  if (!existsSync(SHARES_FILE)) {
    console.error(
      `No ${SHARES_FILE}. If the local stack was initialised another way, unseal it by hand ` +
        "(docs/runbook.md), or start over with `pnpm local:reset` and `pnpm local:secrets:init`.",
    );
    process.exit(1);
  }
  const { shares } = JSON.parse(readFileSync(SHARES_FILE, "utf8")) as {
    shares: string[];
  };
  for (const share of shares.slice(0, 3)) {
    const result = operator(["unseal"], `${share}\n`);
    if (result.code !== 0) {
      console.error(
        "Unsealing failed. The saved shares may belong to an earlier stack: " +
          "`pnpm local:reset` and `pnpm local:secrets:init` start over (deletes local data).",
      );
      process.exit(1);
    }
  }
  console.log(`Secrets service: ${describe(status())}`);
}

const command = process.argv[2];
if (!localDevMode()) {
  console.error(
    "Refusing to run: this helper stores unseal shares in a file, which is only acceptable " +
      "for local development. Set LOCAL_DEV_MODE=true in your .env (never on a server) to use it.",
  );
  process.exit(1);
}

switch (command) {
  case "status":
    console.log(`Secrets service: ${describe(status())}`);
    break;
  case "init": {
    const current = status();
    if (current.initialised) {
      console.log(`Already initialised (${describe(current)}).`);
      if (current.sealed) unseal();
      break;
    }
    const result = operator(["init"]);
    if (result.code !== 0) {
      console.error(`Initialisation failed: ${result.stderr.trim()}`);
      process.exit(1);
    }
    const { shares } = JSON.parse(result.stdout) as { shares: string[] };
    mkdirSync(".local", { recursive: true });
    writeFileSync(
      SHARES_FILE,
      JSON.stringify(
        {
          WARNING:
            "LOCAL DEVELOPMENT ONLY. These are all the unseal shares of your local secrets service. Storing them together like this must never happen outside local development.",
          shares,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      `Initialised. The 5 shares were saved to ${SHARES_FILE} (not shown). Unsealing...`,
    );
    unseal();
    break;
  }
  case "unseal": {
    const current = status();
    if (!current.initialised) {
      console.error("Not initialised yet: run `pnpm local:secrets:init`.");
      process.exit(1);
    }
    if (!current.sealed) {
      console.log("Already unsealed.");
      break;
    }
    unseal();
    break;
  }
  default:
    console.error("Usage: node scripts/local-secrets.ts <init|unseal|status>");
    process.exit(2);
}
