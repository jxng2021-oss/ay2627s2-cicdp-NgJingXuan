import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const DOCUMENTS = [
  { file: "api/openapi.v1.json", kind: "public" },
  { file: "api/openapi.dashboard.json", kind: "dashboard" },
] as const;

function generated(kind: "public" | "dashboard"): string {
  const result = spawnSync(
    "node",
    ["services/gateway/dist/generate-openapi.js", kind],
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
  for (const { file, kind } of DOCUMENTS) {
    writeFileSync(join(REPO, file), generated(kind));
    console.log(`Wrote ${file}`);
  }
}

function check(): void {
  let ok = true;
  for (const { file, kind } of DOCUMENTS) {
    let committed = "";
    try {
      committed = readFileSync(join(REPO, file), "utf8").replace(/\r\n/g, "\n");
    } catch {
      committed = "";
    }
    if (committed !== generated(kind)) {
      console.error(
        `✘ ${file} is out of date: the route schemas changed but the specification wasn't regenerated.\n` +
          "  Run `pnpm api:generate` and commit the result.",
      );
      ok = false;
    } else {
      console.log(`✔ ${file} matches the code`);
    }
  }
  if (!ok) process.exit(1);
}

const commands: Record<string, () => void> = { generate, check };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("Usage: node scripts/openapi.ts <generate|check>");
  process.exit(2);
}
command();
