import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FULL_API_KEY = /sk_[a-z0-9]+_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/;
const SECRET_MARKER = "e2e-secret-value-";
const FILE_CONTENT_MARKER = "e2e-file-content-";
const FILE_NAME_MARKER = "e2e-file-name-";

function compose(args: string[]): { status: number; output: string } {
  const result = spawnSync("docker", ["compose", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}

const failures: string[] = [];
const check = (ok: boolean, passed: string, failed: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${ok ? passed : failed}`);
  if (!ok) failures.push(failed);
};

function hostPort(service: string, port: string): number {
  const match = /:(\d+)\s*$/m.exec(compose(["port", service, port]).output);
  return Number(match?.[1] ?? 0);
}
check(
  hostPort("gateway", "8080") > 0,
  "gateway port 8080 is published on the host (as expected)",
  "gateway port 8080 is not published (is the stack running?)",
);
for (const [service, port] of [
  ["postgres", "5432"],
  ["demo-shop-db", "5432"],
  ["storage", "3001"],
  ["secrets", "3002"],
  ["mock-upstream", "4000"],
  ["redis", "6379"],
  ["audit", "3003"],
  ["identity", "3004"],
  ["flags", "3005"],
] as const) {
  check(
    hostPort(service, port) === 0,
    `${service} port ${port} is not published on the host`,
    `${service} port ${port} is published on the host`,
  );
}

const noPassword = compose([
  "exec",
  "-T",
  "-e",
  "REDISCLI_AUTH=",
  "redis",
  "redis-cli",
  "ping",
]);
check(
  noPassword.output.includes("NOAUTH"),
  "Redis refuses commands without its password",
  `Redis answered without a password: ${noPassword.output.trim()}`,
);

const partials = compose([
  "exec",
  "-T",
  "storage",
  "find",
  "/data",
  "-name",
  "*.part",
]);
check(
  partials.status === 0 && partials.output.trim() === "",
  "no partial upload files in storage",
  `partial upload files found in storage: ${partials.output.trim()}`,
);

const logs = compose(["logs", "--no-color"]);
check(
  logs.status === 0 && !FULL_API_KEY.test(logs.output),
  "no API key in the container logs",
  logs.status === 0
    ? "an API key appears in the container logs"
    : "could not read the logs",
);
check(
  logs.status === 0 && !logs.output.includes(SECRET_MARKER),
  "no secret value in the container logs",
  "a secret value appears in the container logs",
);
check(
  logs.status === 0 && !logs.output.includes(FILE_CONTENT_MARKER),
  "no file content in the container logs",
  "file content appears in the container logs",
);
const internalToken = compose([
  "exec",
  "-T",
  "storage",
  "printenv",
  "INTERNAL_SERVICE_TOKEN",
]).output.trim();
check(
  internalToken.length >= 32 && !logs.output.includes(internalToken),
  "the internal service token is not in the container logs",
  internalToken.length >= 32
    ? "the internal service token appears in the container logs"
    : "could not read storage's internal service token",
);
const gatewayToken = compose([
  "exec",
  "-T",
  "gateway",
  "printenv",
  "INTERNAL_SERVICE_TOKEN",
]);
check(
  gatewayToken.status !== 0 && gatewayToken.output.trim() === "",
  "the gateway doesn't have the internal service token",
  "INTERNAL_SERVICE_TOKEN is set in the gateway container",
);
const masterKeyVariable = compose([
  "exec",
  "-T",
  "secrets",
  "printenv",
  "MASTER_KEY",
]);
check(
  masterKeyVariable.status !== 0 && masterKeyVariable.output.trim() === "",
  "the secrets service has no MASTER_KEY setting (sealed startup)",
  "MASTER_KEY is set in the secrets container",
);

const containerId = compose(["ps", "--quiet", "secrets"]).output.trim();
const inspect = spawnSync(
  "docker",
  [
    "inspect",
    "--format",
    "{{json .HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.Ulimits}}|{{json .Config.User}}",
    containerId,
  ],
  { encoding: "utf8" },
);
const [readOnly, capDrop, securityOpt, ulimits, user] = inspect.stdout
  .trim()
  .split("|");
check(
  inspect.status === 0 &&
    readOnly === "true" &&
    capDrop === '["ALL"]' &&
    (securityOpt ?? "").includes("no-new-privileges:true") &&
    (ulimits ?? "").includes('"Name":"core","Hard":0,"Soft":0') &&
    user === '"secrets"',
  "the secrets container is read-only, drops all capabilities, has no core dumps and doesn't run as root",
  `the secrets container isn't hardened as expected: ${inspect.stdout.trim()}`,
);

const dump = compose([
  "exec",
  "-T",
  "postgres",
  "pg_dump",
  "--username=platform",
  "--dbname=platform",
  "--data-only",
]);
check(
  dump.status === 0 &&
    dump.output.includes("COPY public.api_keys") &&
    !FULL_API_KEY.test(dump.output),
  "no API key stored in plain text in the database",
  dump.status === 0
    ? "an API key is stored in plain text in the database"
    : "could not dump the database",
);

const secretsDump = compose([
  "exec",
  "-T",
  "postgres",
  "pg_dump",
  "--username=platform",
  "--dbname=secrets",
  "--data-only",
]);
check(
  secretsDump.status === 0 &&
    secretsDump.output.includes("COPY public.secret_versions") &&
    !secretsDump.output.includes(SECRET_MARKER),
  "no secret value stored in plain text in the secrets database",
  secretsDump.status === 0
    ? "a secret value is stored in plain text in the secrets database"
    : "could not dump the secrets database",
);

for (const [service, port] of [
  ["dashboard", "3000"],
  ["demo-shop", "3000"],
] as const) {
  const published = compose(["port", service, port]).output.trim();
  check(
    /^127\.0\.0\.1:\d+$/.test(published),
    `${service} is published on 127.0.0.1 only (${published})`,
    `${service} is not published on 127.0.0.1 only: "${published}"`,
  );
}

const auditSecrets = [
  "AUDIT_HMAC_KEY",
  "AUDIT_TOKEN_GATEWAY",
  "AUDIT_TOKEN_SECRETS",
  "AUDIT_TOKEN_STORAGE",
  "AUDIT_TOKEN_IDENTITY",
  "AUDIT_TOKEN_FLAGS",
]
  .map((name) =>
    compose(["exec", "-T", "audit", "printenv", name]).output.trim(),
  )
  .concat(
    compose([
      "exec",
      "-T",
      "identity",
      "printenv",
      "IDENTITY_SERVICE_TOKEN",
    ]).output.trim(),
  );
check(
  auditSecrets.every((value) => value.length >= 32) &&
    auditSecrets.every((value) => !logs.output.includes(value)),
  "no audit token or audit HMAC key in the container logs",
  auditSecrets.every((value) => value.length >= 32)
    ? "an audit token or the audit HMAC key appears in the container logs"
    : "could not read the audit service's settings",
);

const auditDump = compose([
  "exec",
  "-T",
  "postgres",
  "pg_dump",
  "--username=platform",
  "--dbname=audit",
  "--data-only",
]);
check(
  auditDump.status === 0 &&
    auditDump.output.includes("COPY public.audit_events") &&
    !auditDump.output.includes(SECRET_MARKER) &&
    !auditDump.output.includes(FILE_CONTENT_MARKER) &&
    !FULL_API_KEY.test(auditDump.output),
  "no secret value, file content or API key in the audit database",
  auditDump.status === 0
    ? "a secret value, file content or API key is in the audit database"
    : "could not dump the audit database",
);

const identityDump = compose([
  "exec",
  "-T",
  "postgres",
  "pg_dump",
  "--username=platform",
  "--dbname=identity",
  "--data-only",
]);
check(
  identityDump.status === 0 &&
    identityDump.output.includes("COPY public.pool_users") &&
    !identityDump.output.includes("BEGIN PRIVATE KEY") &&
    !/"d":\s*"/.test(identityDump.output) &&
    !identityDump.output.includes(SECRET_MARKER) &&
    !FULL_API_KEY.test(identityDump.output),
  "no private signing key, secret value or API key in the identity database",
  identityDump.status === 0
    ? "a private key, secret value or API key is in the identity database"
    : "could not dump the identity database",
);

const onDisk = compose([
  "exec",
  "-T",
  "storage",
  "sh",
  "-c",
  `grep -rl '${FILE_CONTENT_MARKER}' /data; find /data -name '*${FILE_NAME_MARKER}*'; find /data -type f | wc -l`,
]);
const diskLines = onDisk.output.trim().split("\n");
check(
  diskLines.length === 1 && Number(diskLines[0]) > 0,
  `no file content or file name on the storage volume (${diskLines[0]} encrypted files checked)`,
  `plain file content or names found on the storage volume (or no files to check): ${onDisk.output.trim()}`,
);
const storageDump = compose([
  "exec",
  "-T",
  "postgres",
  "pg_dump",
  "--username=platform",
  "--dbname=storage",
  "--data-only",
]);
check(
  storageDump.status === 0 &&
    storageDump.output.includes("COPY public.files") &&
    !storageDump.output.includes(FILE_CONTENT_MARKER),
  "no file content stored in the storage database",
  storageDump.status === 0
    ? "file content is stored in the storage database"
    : "could not dump the storage database",
);

const deployFiles = [
  "deploy/docker-compose.yml",
  "deploy/deploy.sh",
  "deploy/smoke-test.sh",
];
const mentions = deployFiles.filter((file) =>
  readFileSync(file, "utf8").includes("mock-upstream"),
);
check(
  mentions.length === 0,
  "the mock outside API isn't in the deployment files",
  `the mock outside API appears in: ${mentions.join(", ")}`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll stack checks passed");
