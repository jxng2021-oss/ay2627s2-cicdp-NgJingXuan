import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerRun, REPO } from "./docker.ts";

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
const ALLOWED_BREAKING_CHANGES = "api/breaking-changes-allowed.txt";
const OASDIFF_IMAGE =
  "tufin/oasdiff:v1.34.0@sha256:dd742562c1f3146f6e2a80bc01951cc87d15a249ac2aca05665339e30cf03620";

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
    let committed = "";
    try {
      committed = readFileSync(join(REPO, file), "utf8").replace(/\r\n/g, "\n");
    } catch {}
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

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function breaking(): void {
  const revision = option("--revision-file") ?? SPEC;
  let base = option("--base-file");

  if (!base) {
    const baseRef = option("--base-ref") || process.env.API_BASE_REF || "main";
    const shown = spawnSync("git", ["show", `${baseRef}:${SPEC}`], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (shown.error) {
      console.error(
        `✘ Could not read ${SPEC} on ${baseRef}: ${shown.error.message}`,
      );
      process.exit(1);
    }
    if (shown.status !== 0) {
      console.log(
        `::notice::No ${SPEC} on ${baseRef} yet, so there is nothing to compare against. ` +
          "Breaking-change checks start once it exists there.",
      );
      return;
    }
    mkdirSync(join(REPO, ".cache"), { recursive: true });
    base = ".cache/openapi-base.json";
    writeFileSync(join(REPO, base), shown.stdout);
    console.log(`Comparing ${revision} with ${SPEC} on ${baseRef}`);
  }

  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    console.error("✘ oasdiff could not run: Docker isn't running.");
    process.exit(1);
  }

  console.log("\n--- All changes ---");
  dockerRun(OASDIFF_IMAGE, ["changelog", base, revision]);

  console.log("\n--- Breaking changes ---");
  const status = dockerRun(OASDIFF_IMAGE, [
    "breaking",
    base,
    revision,
    "--fail-on",
    "ERR",
    "--err-ignore",
    ALLOWED_BREAKING_CHANGES,
  ]);
  if (status !== 0 && status !== 1) {
    console.error(
      `\n✘ oasdiff could not run (exit code ${status}). Is Docker running?`,
    );
    process.exit(1);
  }
  if (status === 1) {
    console.error(
      "\n✘ Breaking API change. Existing clients would stop working.\n" +
        "  Make it backwards compatible, add it as a new version (/v2/...), or, if it's\n" +
        `  truly intended, list it with a reason in ${ALLOWED_BREAKING_CHANGES} (see docs/api.md).`,
    );
    process.exit(1);
  }
  console.log("✔ No breaking changes");
}

const commands: Record<string, () => void> = { generate, check, breaking };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(
    "Usage: node scripts/openapi.ts <generate|check|breaking> [options]",
  );
  process.exit(2);
}
command();
