import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalTeardown(): void {
  if (process.env.LOCAL_DEV_MODE !== "true") return;
  spawnSync("node", ["scripts/local-secrets.ts", "unseal"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: "inherit",
  });
}
