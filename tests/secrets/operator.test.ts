import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../services/secrets/src/app.js";
import type { Database } from "../../services/secrets/src/db/client.js";
import { buildOperatorApp } from "../../services/secrets/src/operator-app.js";
import { runOperatorCommand } from "../../services/secrets/src/operator-cli.js";
import { SealManager } from "../../services/secrets/src/seal/seal-manager.js";
import {
  createTestDatabase,
  FakeAudit,
  IDENTITY_SERVICE_TOKEN,
  INTERNAL_SERVICE_TOKEN,
} from "./helpers.js";

let db: Database;
let manager: SealManager;
let socketPath: string;
const servers: FastifyInstance[] = [];

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  manager = new SealManager(db, {
    unsealTimeoutMs: 60_000,
    maxFailedAttempts: 5,
    lockoutMs: 60_000,
    drainTimeoutMs: 1_000,
  });
  await manager.load();
  socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\secrets-operator-test-${randomUUID()}`
      : join(tmpdir(), `secrets-operator-${randomUUID()}.sock`);
  const operator = buildOperatorApp(manager);
  servers.push(operator);
  await operator.listen({ path: socketPath });
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function operator(args: string[], input = "") {
  let stdout = "";
  let stderr = "";
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        append(chunk.toString());
        callback();
      },
    });
  const code = await runOperatorCommand(args, {
    stdin: Readable.from(input ? [input] : []),
    stdout: sink((t) => (stdout += t)),
    stderr: sink((t) => (stderr += t)),
    socketPath,
  });
  return { code, stdout, stderr };
}

async function initialise(): Promise<string[]> {
  const result = await operator(["init", "--json"]);
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout) as { shares: string[] }).shares;
}

describe("operator command", () => {
  it("status, init (shares shown once), unseal one share at a time, seal", async () => {
    expect((await operator(["status"])).stdout).toMatch(/Not initialised/);

    const init = await operator(["init"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/shown ONCE/);
    const shares = [...init.stdout.matchAll(/Share \d: (\S+)/g)].map(
      (m) => m[1]!,
    );
    expect(shares).toHaveLength(5);

    const again = await operator(["init"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already initialised/);
    expect(again.stdout).toBe("");

    const one = await operator(["unseal"], `${shares[1]!}\n`);
    expect(one.stdout).toMatch(/Unseal progress: 1 of 3 shares/);
    const dup = await operator(["unseal"], `${shares[1]!}\n`);
    expect(dup.stdout).toMatch(/already submitted; it was ignored/);
    expect(dup.stdout).toMatch(/1 of 3/);
    expect((await operator(["unseal"], `${shares[3]!}\n`)).stdout).toMatch(
      /2 of 3/,
    );
    const last = await operator(["unseal"], `${shares[4]!}\n`);
    expect(last.stdout).toMatch(/Unsealed/);
    expect(manager.state).toBe("unsealed");

    expect((await operator(["seal"])).stdout).toMatch(/Sealed/);
    expect(manager.state).toBe("sealed");
    for (const output of [one, dup, last]) {
      for (const share of shares)
        expect(output.stdout + output.stderr).not.toContain(share);
    }
  });

  it("never accepts a share on the command line", async () => {
    const shares = await initialise();

    const result = await operator(["unseal", shares[0]!]);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/never accepted on the command line/);
    expect(result.stderr).not.toContain(shares[0]!);
    expect(manager.status().progress).toBe(0);
  });

  it("reports a wrong share generically, without repeating it", async () => {
    const shares = await initialise();
    await operator(["unseal"], shares[0]);
    await operator(["unseal"], shares[1]);
    const used = new Set(
      [shares[0]!, shares[1]!].map((share) => Buffer.from(share, "base64")[32]),
    );
    const unusedNumber = [...Array(255).keys()]
      .map((n) => n + 1)
      .find((n) => !used.has(n))!;
    const wrong = Buffer.alloc(33, unusedNumber).toString("base64");

    const result = await operator(["unseal"], wrong);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unsealing failed. Progress was cleared/);
    expect(result.stderr).not.toContain(wrong);
    expect(manager.state).toBe("sealed");
  });

  it("reads a share from a hidden prompt on a terminal", async () => {
    const shares = await initialise();
    const typed = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (raw: boolean) => void;
    };
    const rawModes: boolean[] = [];
    typed.isTTY = true;
    typed.setRawMode = (raw) => rawModes.push(raw);
    let shown = "";
    const stdout = new Writable({
      write(chunk: Buffer, _e, callback) {
        shown += chunk.toString();
        callback();
      },
    });

    const running = runOperatorCommand(["unseal"], {
      stdin: typed,
      stdout,
      stderr: stdout,
      socketPath,
    });
    for (const char of `${shares[2]!}Z\u007f\r`) typed.write(char);
    expect(await running).toBe(0);

    expect(rawModes).toEqual([true, false]);
    expect(shown).toMatch(/input hidden/);
    expect(shown).not.toContain(shares[2]!);
    expect(manager.status().progress).toBe(1);
  });

  it("explains when the service can't be reached", async () => {
    socketPath = `${socketPath}-missing`;

    const result = await operator(["status"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /Could not reach the secrets service's operator socket/,
    );
  });
});

describe("operator actions are not part of the service's HTTP API", () => {
  it("the network listener has no init, unseal, seal or status routes", async () => {
    const app = buildApp({
      db,
      keyProvider: manager,
      maxSecretBytes: 1024,
      internalServiceToken: INTERNAL_SERVICE_TOKEN,
      identityServiceToken: IDENTITY_SERVICE_TOKEN,
      audit: new FakeAudit().client,
    });
    servers.push(app);
    await app.ready();

    for (const url of [
      "/init",
      "/unseal",
      "/seal",
      "/status",
      "/operator/init",
      "/operator/unseal",
    ]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { "x-tenant-id": randomUUID() },
          ...(method === "POST" ? { payload: { share: "x" } } : {}),
        });
        expect(response.statusCode).toBe(404);
      }
    }
    expect(manager.state).toBe("uninitialised");
  });
});
