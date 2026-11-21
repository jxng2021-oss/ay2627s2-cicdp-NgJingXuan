import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const SPEC = "api/openapi.v1.json";
const DASHBOARD_SPEC = "api/openapi.dashboard.json";
const TYPES = [
  { spec: DASHBOARD_SPEC, output: "apps/dashboard/src/lib/api/schema.d.ts" },
  { spec: SPEC, output: "apps/demo-shop/src/lib/platform/schema.d.ts" },
] as const;
const DOCUMENTS = [
  { file: SPEC, kind: "public" },
  { file: DASHBOARD_SPEC, kind: "dashboard" },
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

function writeTypes(spec: string, output: string): void {
  const result = spawnSync(
    "node",
    [
      "apps/dashboard/node_modules/openapi-typescript/bin/cli.js",
      spec,
      "--output",
      output,
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    console.error(`Could not generate the API types for ${spec}.`);
    process.exit(1);
  }
}

function readText(file: string): string {
  try {
    return readFileSync(join(REPO, file), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

function generate(): void {
  for (const { file, kind } of DOCUMENTS) {
    writeFileSync(join(REPO, file), generated(kind));
    console.log(`Wrote ${file}`);
  }
  for (const { spec, output } of TYPES) {
    writeTypes(spec, output);
    console.log(`Wrote ${output}`);
  }
}

function check(): void {
  let ok = true;
  for (const { file, kind } of DOCUMENTS) {
    if (readText(file) !== generated(kind)) {
      console.error(
        `✘ ${file} is out of date: the route schemas changed but the specification wasn't regenerated.\n` +
          "  Run `pnpm api:generate` and commit the result.",
      );
      ok = false;
    } else {
      console.log(`✔ ${file} matches the code`);
    }
  }

  mkdirSync(join(REPO, ".cache"), { recursive: true });
  const fresh = ".cache/fresh-schema.d.ts";
  for (const { spec, output } of TYPES) {
    writeTypes(spec, fresh);
    const matches = readText(fresh) === readText(output);
    rmSync(join(REPO, fresh), { force: true });
    if (!matches) {
      console.error(
        `✘ ${output} is out of date: it doesn't match ${spec}.\n` +
          "  Run `pnpm api:generate` and commit the result.",
      );
      ok = false;
    } else {
      console.log(`✔ ${output} matches ${spec}`);
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
