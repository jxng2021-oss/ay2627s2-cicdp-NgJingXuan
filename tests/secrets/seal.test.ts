import { createSecretKey, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { combine } from "shamir-secret-sharing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../services/secrets/src/app.js";
import { open } from "../../services/secrets/src/crypto/aes-gcm.js";
import type { Database } from "../../services/secrets/src/db/client.js";
import {
  sealConfig,
  tenantKeys,
} from "../../services/secrets/src/db/schema.js";
import { buildOperatorApp } from "../../services/secrets/src/operator-app.js";
import {
  AlreadyInitialisedError,
  LeftoverDataError,
  NotInitialisedError,
  SealManager,
  TooManyAttemptsError,
  UnsealFailedError,
  type SealSettings,
} from "../../services/secrets/src/seal/seal-manager.js";
import {
  decodeShare,
  InvalidShareError,
  shareNumber,
} from "../../services/secrets/src/seal/shares.js";
import {
  call,
  captureLogs,
  createTestDatabase,
  FakeAudit,
  IDENTITY_SERVICE_TOKEN,
  INTERNAL_SERVICE_TOKEN,
  newTenant,
} from "./helpers.js";

const SETTINGS: SealSettings = {
  unsealTimeoutMs: 60_000,
  maxFailedAttempts: 5,
  lockoutMs: 60_000,
  drainTimeoutMs: 1_000,
};

let db: Database;
let client: PGlite;
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  ({ db, client } = await createTestDatabase());
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function startManager(
  settings: Partial<SealSettings> = {},
  now?: () => number,
) {
  const manager = new SealManager(db, { ...SETTINGS, ...settings }, now);
  await manager.load();
  return manager;
}

async function startService(
  manager: SealManager,
  logStream?: NodeJS.WritableStream,
) {
  const app = buildApp({
    db,
    keyProvider: manager,
    maxSecretBytes: 1024,
    internalServiceToken: INTERNAL_SERVICE_TOKEN,
    identityServiceToken: IDENTITY_SERVICE_TOKEN,
    audit: new FakeAudit().client,
    logger: logStream ? { level: "info", stream: logStream } : false,
  });
  apps.push(app);
  await app.ready();
  return app;
}

async function unsealWith(manager: SealManager, shares: string[]) {
  let last;
  for (const share of shares) last = await manager.submitShare(share);
  return last;
}

function strangerShare(x = 200): string {
  const bytes = randomBytes(33);
  bytes[32] = x;
  return bytes.toString("base64");
}

describe("before initialisation", () => {
  it("starts uninitialised: secrets 503 SECRETS_SEALED, healthy but not ready", async () => {
    const manager = await startManager();
    const app = await startService(manager);

    const secret = await call(app, newTenant(), "GET", "/secrets/x");
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(manager.state).toBe("uninitialised");
    expect(secret.statusCode).toBe(503);
    expect(secret.json()).toMatchObject({ error: { code: "SECRETS_SEALED" } });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: "not_ready",
      reason: "not_initialised",
    });
    await expect(manager.submitShare(strangerShare())).rejects.toThrow(
      NotInitialisedError,
    );
  });
});

describe("initialisation", () => {
  it("creates 5 shares (any 3 unseal) and stays sealed", async () => {
    const manager = await startManager();

    const { shares, threshold } = await manager.initialise();

    expect(shares).toHaveLength(5);
    expect(new Set(shares).size).toBe(5);
    expect(threshold).toBe(3);
    expect(manager.status()).toEqual({
      initialised: true,
      sealed: true,
      shares: 5,
      threshold: 3,
      progress: 0,
    });
  });

  it("only succeeds once", async () => {
    const manager = await startManager();
    await manager.initialise();

    await expect(manager.initialise()).rejects.toThrow(AlreadyInitialisedError);
    await expect((await startManager()).initialise()).rejects.toThrow(
      AlreadyInitialisedError,
    );
  });

  it("only one of several simultaneous attempts succeeds (one process or several)", async () => {
    const one = await startManager();
    const managers = [
      one,
      one,
      await startManager(),
      await startManager(),
      await startManager(),
    ];

    const results = await Promise.allSettled(
      managers.map((m) => m.initialise()),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(AlreadyInitialisedError);
    }
    expect((await client.query("select * from seal_config")).rows).toHaveLength(
      1,
    );
  });

  it("a failure part-way stores nothing, so it can simply be tried again", async () => {
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return () => {
            throw new Error("database went away");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const broken = new SealManager(failing, SETTINGS);
    await broken.load();

    await expect(broken.initialise()).rejects.toThrow("database went away");

    expect((await client.query("select * from seal_config")).rows).toEqual([]);
    expect(broken.state).toBe("uninitialised");
    const retry = await startManager();
    await expect(retry.initialise()).resolves.toMatchObject({ threshold: 3 });
  });

  it("refuses when keys or secrets from an earlier setup are still stored", async () => {
    await db.insert(tenantKeys).values({
      tenantId: newTenant(),
      keyVersion: 1,
      masterKeyVersion: 1,
      formatVersion: 1,
      nonce: randomBytes(12),
      ciphertext: randomBytes(32),
      authTag: randomBytes(16),
    });
    const manager = await startManager();

    await expect(manager.initialise()).rejects.toThrow(LeftoverDataError);
    expect((await client.query("select * from seal_config")).rows).toEqual([]);
  });
});

describe("unsealing", () => {
  it("any 3 of the 5 shares unseal it", async () => {
    const { shares } = await (await startManager()).initialise();
    const groups: string[][] = [];
    for (let a = 0; a < 5; a++)
      for (let b = a + 1; b < 5; b++)
        for (let c = b + 1; c < 5; c++)
          groups.push([shares[a]!, shares[b]!, shares[c]!]);
    expect(groups).toHaveLength(10);

    for (const group of groups) {
      const manager = await startManager();
      const result = await unsealWith(manager, group);
      expect(result).toMatchObject({ sealed: false, progress: 0 });
      expect(manager.state).toBe("unsealed");
    }
  });

  it("shows progress, and 2 shares are not enough", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();

    expect(await manager.submitShare(shares[0]!)).toMatchObject({
      sealed: true,
      progress: 1,
    });
    expect(await manager.submitShare(shares[3]!)).toMatchObject({
      sealed: true,
      progress: 2,
    });
    expect(manager.state).toBe("sealed");
  });

  it("ignores a share submitted twice", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();

    await manager.submitShare(shares[0]!);
    const again = await manager.submitShare(` ${shares[0]!}\n`);
    expect(again).toMatchObject({ duplicate: true, progress: 1, sealed: true });

    await manager.submitShare(shares[1]!);
    expect(await manager.submitShare(shares[2]!)).toMatchObject({
      sealed: false,
    });
  });

  it("a wrong share: generic failure, progress cleared, still sealed", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();
    await manager.submitShare(shares[0]!);
    await manager.submitShare(shares[1]!);

    const error = await manager
      .submitShare(strangerShare())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsealFailedError);
    expect((error as Error).message).toBe(
      "Unsealing failed. Progress was cleared; start again.",
    );
    expect(manager.status()).toMatchObject({ sealed: true, progress: 0 });
    await unsealWith(manager, [shares[0]!, shares[1]!, shares[2]!]);
    expect(manager.state).toBe("unsealed");
  });

  it("shares from another initialisation fail", async () => {
    const first = await (await startManager()).initialise();
    await client.exec("truncate table seal_config");
    const second = await (await startManager()).initialise();
    const manager = await startManager();

    await expect(unsealWith(manager, first.shares.slice(0, 3))).rejects.toThrow(
      UnsealFailedError,
    );
    const usedNumbers = new Set(
      second.shares.slice(0, 2).map((share) => shareNumber(decodeShare(share))),
    );
    const foreignShare = first.shares.find(
      (share) => !usedNumbers.has(shareNumber(decodeShare(share))),
    )!;
    await expect(
      unsealWith(manager, [second.shares[0]!, second.shares[1]!, foreignShare]),
    ).rejects.toThrow(UnsealFailedError);
    await unsealWith(manager, second.shares.slice(2, 5));
    expect(manager.state).toBe("unsealed");
  });

  it.each([
    ["not base64", "this is not a share!"],
    ["too short", Buffer.alloc(20, 1).toString("base64")],
    ["too long", Buffer.alloc(40, 1).toString("base64")],
    ["empty", ""],
    ["share number 0", Buffer.alloc(33, 0).toString("base64")],
  ])(
    "rejects a malformed share (%s) without revealing it",
    async (_case, text) => {
      await (await startManager()).initialise();
      const manager = await startManager();

      const error = await manager.submitShare(text).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidShareError);
      if (text) expect((error as Error).message).not.toContain(text);
    },
  );

  it("rejects a different share with the same number as one already submitted", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();
    await manager.submitShare(shares[0]!);
    const x = Buffer.from(shares[0]!, "base64")[32]!;

    await expect(manager.submitShare(strangerShare(x))).rejects.toThrow(
      InvalidShareError,
    );
  });

  it("forgets partial progress after the timeout", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager({ unsealTimeoutMs: 50 });
    await manager.submitShare(shares[0]!);
    await manager.submitShare(shares[1]!);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(manager.status().progress).toBe(0);
    expect(await manager.submitShare(shares[2]!)).toMatchObject({
      progress: 1,
      sealed: true,
    });
  });

  it("limits failed attempts: a lockout, then it works again", async () => {
    const { shares } = await (await startManager()).initialise();
    let now = 1_000_000;
    const manager = await startManager(
      { maxFailedAttempts: 3, lockoutMs: 60_000 },
      () => now,
    );

    for (let i = 0; i < 3; i++) {
      await expect(manager.submitShare("bad")).rejects.toThrow(
        InvalidShareError,
      );
    }
    const locked = await manager
      .submitShare(shares[0]!)
      .catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(TooManyAttemptsError);
    expect((locked as TooManyAttemptsError).retryAfterSeconds).toBe(60);

    now += 60_001;
    await unsealWith(manager, shares.slice(0, 3));
    expect(manager.state).toBe("unsealed");
  });

  it("failed unseals count towards the limit too", async () => {
    await (await startManager()).initialise();
    const manager = await startManager({ maxFailedAttempts: 2 });

    for (let i = 0; i < 2; i++) {
      await expect(
        unsealWith(manager, [
          strangerShare(1),
          strangerShare(2),
          strangerShare(3),
        ]),
      ).rejects.toThrow(UnsealFailedError);
    }

    await expect(manager.submitShare(strangerShare(4))).rejects.toThrow(
      TooManyAttemptsError,
    );
  });
});

describe("sealed and unsealed service", () => {
  it("blocks secrets while sealed, serves them once unsealed, and is sealed again after a restart", async () => {
    const tenant = newTenant();
    const { shares } = await (await startManager()).initialise();

    const manager = await startManager();
    const app = await startService(manager);
    const blocked = await call(
      app,
      tenant,
      "PUT",
      "/secrets/db-password",
      "value-1",
    );
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({
      error: {
        code: "SECRETS_SEALED",
        message: "The secrets service is sealed until an operator unseals it",
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/ready" })).json(),
    ).toMatchObject({
      status: "not_ready",
      reason: "sealed",
      checks: { seal: "sealed" },
    });

    await unsealWith(manager, [shares[4]!, shares[0]!, shares[2]!]);
    expect(
      (await call(app, tenant, "PUT", "/secrets/db-password", "value-1"))
        .statusCode,
    ).toBe(201);
    expect(
      (await app.inject({ method: "GET", url: "/ready" })).json(),
    ).toMatchObject({
      status: "ready",
      checks: { seal: "unsealed" },
    });

    const restarted = await startManager();
    const app2 = await startService(restarted);
    expect(restarted.state).toBe("sealed");
    expect(
      (await call(app2, tenant, "GET", "/secrets/db-password")).statusCode,
    ).toBe(503);

    await unsealWith(restarted, [shares[1]!, shares[3]!, shares[4]!]);
    const read = await call(
      app2,
      tenant,
      "GET",
      "/internal/secrets/db-password",
    );
    expect(read.json()).toMatchObject({ value: "value-1" });
  });

  it("seal: refuses new requests at once, waits for running ones, then wipes the key", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();
    await unsealWith(manager, shares.slice(0, 3));
    expect(manager.beginRequest()).toBe(true);

    let sealed = false;
    const sealing = manager.seal().then(() => (sealed = true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.state).toBe("sealed");
    expect(manager.beginRequest()).toBe(false);
    expect(() => manager.masterKey(1)).not.toThrow();
    expect(sealed).toBe(false);

    manager.endRequest();
    await sealing;
    expect(() => manager.masterKey(1)).toThrow("sealed");
  });

  it("seal gives up waiting after the drain timeout", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager({ drainTimeoutMs: 50 });
    await unsealWith(manager, shares.slice(0, 3));
    manager.beginRequest();

    await manager.seal();

    expect(() => manager.masterKey(1)).toThrow("sealed");
  });
});

describe("what is kept, logged and stored", () => {
  it("shares and keys never appear in logs, errors or the database", async () => {
    const logs = captureLogs();
    const operator = buildOperatorApp(await startManager());
    apps.push(operator);
    const init = await operator.inject({ method: "POST", url: "/init" });
    const { shares } = init.json<{ shares: string[] }>();
    const manager = await startManager();
    const app = await startService(manager, logs.stream);
    const op = buildOperatorApp(manager);
    apps.push(op);

    const wrong = await op.inject({
      method: "POST",
      url: "/unseal",
      payload: { share: `${shares[0]!}x` },
    });
    const bad = await op.inject({
      method: "POST",
      url: "/unseal",
      headers: { "content-type": "application/json" },
      payload: `{"share": "${shares[1]!}`,
    });
    for (const share of shares.slice(0, 3)) {
      await op.inject({ method: "POST", url: "/unseal", payload: { share } });
    }
    await call(app, newTenant(), "PUT", "/secrets/x", "value");
    await call(app, newTenant(), "GET", "/secrets/x");
    await op.inject({ method: "POST", url: "/seal" });

    const unsealKey = Buffer.from(
      await combine(
        shares.slice(0, 3).map((s) => new Uint8Array(Buffer.from(s, "base64"))),
      ),
    );
    const [config] = await db.select().from(sealConfig);
    const masterKey = open(
      createSecretKey(unsealKey),
      config!,
      Buffer.from(JSON.stringify(["master-key", 1, config!.sealId, 1, 5, 3])),
    );
    const needles = [
      ...shares.map((s) => Buffer.from(s, "base64")),
      unsealKey,
      masterKey,
    ];

    const text = logs.text() + wrong.body + bad.body;
    for (const share of shares) expect(text).not.toContain(share);
    expect([wrong.statusCode, bad.statusCode]).toEqual([400, 400]);
    for (const needle of needles) {
      expect(text).not.toContain(needle.toString("base64"));
      expect(text).not.toContain(needle.toString("hex"));
    }

    const tables = ["seal_config", "tenant_keys", "secrets", "secret_versions"];
    const stored = Buffer.concat(
      (
        await Promise.all(
          tables.map((t) =>
            client.query<Record<string, unknown>>(`select * from ${t}`),
          ),
        )
      ).flatMap((r) =>
        r.rows.flatMap((row) =>
          Object.values(row).map((v) =>
            v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v)),
          ),
        ),
      ),
    );
    for (const needle of needles) {
      expect(stored.includes(needle)).toBe(false);
      expect(stored.includes(Buffer.from(needle.toString("base64")))).toBe(
        false,
      );
    }
  });

  it("the database alone can't decrypt anything: a new process with the same database is sealed", async () => {
    const { shares } = await (await startManager()).initialise();
    const manager = await startManager();
    await unsealWith(manager, shares.slice(0, 3));
    const app = await startService(manager);
    const tenant = newTenant();
    await call(app, tenant, "PUT", "/secrets/x", "only readable when unsealed");

    const fresh = await startManager();
    const app2 = await startService(fresh);

    expect(fresh.state).toBe("sealed");
    expect(() => fresh.masterKey(1)).toThrow("sealed");
    const read = await call(app2, tenant, "GET", "/secrets/x");
    expect(read.statusCode).toBe(503);
    expect(read.body).not.toContain("only readable");
  });
});

describe("the old MASTER_KEY", () => {
  it("has no effect if it is set", async () => {
    const before = process.env.MASTER_KEY;
    process.env.MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const manager = await startManager();
      const app = await startService(manager);
      expect(manager.state).toBe("uninitialised");
      expect((await call(app, newTenant(), "GET", "/secrets")).statusCode).toBe(
        503,
      );

      await manager.initialise();
      const restarted = await startManager();
      expect(restarted.state).toBe("sealed");
      expect(() => restarted.masterKey(1)).toThrow("sealed");
    } finally {
      if (before === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = before;
    }
  });

  it("isn't read anywhere in the service's code", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(
      new URL("../../services/secrets/src", import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        "$1",
      ),
    );

    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /(?<![A-Z_])MASTER_KEY(?![A-Z_])/,
      );
    }
  });
});
