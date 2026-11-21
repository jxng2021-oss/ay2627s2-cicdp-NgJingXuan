import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const SERVICES = [
  "services/gateway",
  "services/audit",
  "services/identity",
  "services/flags",
];
const SCRATCH = ".migrations-check";

function drizzleKit(
  cwd: string,
  args: string[],
): { status: number; output: string } {
  console.log(`$ drizzle-kit ${args.join(" ")}`);
  const result = spawnSync("pnpm", ["exec", "drizzle-kit", ...args], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  console.log(output);
  return { status: result.status ?? 1, output };
}

function fail(message: string): never {
  console.error(`\n✘ ${message}`);
  process.exit(1);
}

for (const service of SERVICES) {
  const dir = resolve(service);
  console.log(`\n=== ${service} ===`);

  const check = drizzleKit(dir, ["check"]);
  if (check.status !== 0 || !/Everything's fine/i.test(check.output)) {
    fail(`${service}: the migration history is inconsistent (see above).`);
  }

  rmSync(join(dir, SCRATCH), { recursive: true, force: true });
  cpSync(join(dir, "drizzle"), join(dir, SCRATCH, "drizzle"), {
    recursive: true,
  });
  const generate = drizzleKit(dir, [
    "generate",
    "--dialect=postgresql",
    "--schema=./src/db/schema.ts",
    `--out=${SCRATCH}/drizzle`,
  ]);
  rmSync(join(dir, SCRATCH), { recursive: true, force: true });

  if (/Your SQL migration file/i.test(generate.output)) {
    fail(
      `${service}: schema.ts has changes with no migration. Run ` +
        `\`pnpm db:generate\` and commit the new file in ${service}/drizzle/.`,
    );
  }
  if (generate.status !== 0 || !/No schema changes/i.test(generate.output)) {
    fail(
      `${service}: drizzle-kit could not compare the schema with the migrations (see above).`,
    );
  }
}
console.log("\n✔ Migrations are consistent and match the schema");
