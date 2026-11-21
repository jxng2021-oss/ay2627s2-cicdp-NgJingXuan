import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const SPEC = "api/openapi.v1.json";

function generated(): string {
  const result = spawnSync(
    "node",
    ["services/gateway/dist/generate-openapi.js"],
    {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    console.error(
      "Could not generate the specification. Did the gateway build?",
    );
    process.exit(1);
  }
  return result.stdout;
}

function generate(): void {
  writeFileSync(join(REPO, SPEC), generated());
  console.log(`Wrote ${SPEC}`);
}

function check(): void {
  let committed = "";
  try {
    committed = readFileSync(join(REPO, SPEC), "utf8").replace(/\r\n/g, "\n");
  } catch {
    committed = "";
  }
  if (committed !== generated()) {
    console.error(
      `✘ ${SPEC} is out of date: the route schemas changed but the specification wasn't regenerated.\n` +
        "  Run `pnpm api:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`✔ ${SPEC} matches the code`);
}

const commands: Record<string, () => void> = { generate, check };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("Usage: node scripts/openapi.ts <generate|check>");
  process.exit(2);
}
command();
