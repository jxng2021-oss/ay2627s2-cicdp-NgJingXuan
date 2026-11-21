import { spawnSync } from "node:child_process";

export const REPO = process.cwd();

export function dockerRun(
  image: string,
  args: string[],
  env: Record<string, string> = {},
  entrypoint?: string,
): number {
  const dockerArgs = ["run", "--rm", "-v", `${REPO}:/src`, "-w", "/src"];
  if (entrypoint) dockerArgs.push("--entrypoint", entrypoint);

  if (process.getuid && process.getgid) {
    dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  const allEnv: Record<string, string> = {
    HOME: "/tmp",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/src",
    ...env,
  };
  for (const [name, value] of Object.entries(allEnv)) {
    dockerArgs.push("-e", `${name}=${value}`);
  }

  const result = spawnSync("docker", [...dockerArgs, image, ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
