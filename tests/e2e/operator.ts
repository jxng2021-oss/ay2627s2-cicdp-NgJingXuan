import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCAL_SHARES_FILE = `${REPO_ROOT}.local/secrets-unseal-shares.json`;

export interface SealStatus {
  initialised: boolean;
  sealed: boolean;
  progress: number;
  threshold: number;
  duplicate?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function dockerCompose(
  args: string[],
  input = "",
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function secretsOperator(
  args: string[],
  input = "",
): Promise<CommandResult> {
  return dockerCompose(
    ["exec", "-T", "secrets", "secrets-operator", ...args, "--json"],
    input,
  );
}

export async function sealStatus(): Promise<SealStatus> {
  const result = await secretsOperator(["status"]);
  if (result.code !== 0) {
    throw new Error(`secrets operator status failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as SealStatus;
}

export async function submitShare(
  share: string,
): Promise<{ code: number; status?: SealStatus }> {
  const result = await secretsOperator(["unseal"], `${share}\n`);
  return {
    code: result.code,
    status:
      result.code === 0 ? (JSON.parse(result.stdout) as SealStatus) : undefined,
  };
}

function localDevMode(): boolean {
  if (process.env.LOCAL_DEV_MODE !== undefined) {
    return process.env.LOCAL_DEV_MODE === "true";
  }
  const env = `${REPO_ROOT}.env`;
  return (
    existsSync(env) &&
    /^LOCAL_DEV_MODE=true\s*$/m.test(readFileSync(env, "utf8"))
  );
}

export async function prepareSecrets(): Promise<string[]> {
  let shares: string[];
  const status = await sealStatus();

  if (!status.initialised) {
    const init = await secretsOperator(["init"]);
    if (init.code !== 0) {
      throw new Error(
        `initialising the secrets service failed: ${init.stderr.trim()}`,
      );
    }
    shares = (JSON.parse(init.stdout) as { shares: string[] }).shares;
    if (localDevMode()) {
      mkdirSync(`${REPO_ROOT}.local`, { recursive: true });
      writeFileSync(
        LOCAL_SHARES_FILE,
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
    }
  } else if (localDevMode() && existsSync(LOCAL_SHARES_FILE)) {
    shares = (
      JSON.parse(readFileSync(LOCAL_SHARES_FILE, "utf8")) as {
        shares: string[];
      }
    ).shares;
  } else {
    throw new Error(
      "The secrets service was initialised before this test run, and its shares aren't available. " +
        "Start from a fresh stack (pnpm local:reset && pnpm e2e:start), or set LOCAL_DEV_MODE=true " +
        "and initialise it with `pnpm local:secrets:init`.",
    );
  }

  await unsealWith(shares);
  return shares;
}

export async function unsealWith(shares: string[]): Promise<void> {
  if (!(await sealStatus()).sealed) return;
  for (const share of shares.slice(0, 3)) {
    if ((await submitShare(share)).code !== 0) {
      throw new Error(
        "unsealing the secrets service failed (are these the right shares?)",
      );
    }
  }
  if ((await sealStatus()).sealed)
    throw new Error("the secrets service is still sealed");
}
