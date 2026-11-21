import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const envFiles = existsSync(".env")
  ? ["--env-file", ".env", "--env-file", "tests/e2e/e2e.env"]
  : ["--env-file", "tests/e2e/e2e.env"];

const result = spawnSync(
  "docker",
  ["compose", ...envFiles, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
