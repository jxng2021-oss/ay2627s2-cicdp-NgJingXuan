import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createTenantWithKey,
  download,
  expectError,
  freshWindow,
  GATEWAY_URL,
  psql,
  secrets,
  sleep,
  upload,
  injectedValue,
} from "./helpers.js";
import {
  dockerCompose,
  sealStatus,
  secretsOperator,
  submitShare,
  unsealWith,
} from "./operator.js";

const shares = inject("unsealShares");
let key = "";
let fileId = "";
const FILE = randomBytes(1024);
const VALUE = "e2e-secret-value-sealing";

async function nodeIn(service: string, script: string): Promise<string> {
  const result = await dockerCompose([
    "exec",
    "-T",
    service,
    "node",
    "-e",
    script,
  ]);
  return result.stdout.trim();
}

async function waitForSecrets(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await secretsOperator(["status"])).code === 0) return;
    await sleep(500);
  }
  throw new Error("the secrets service didn't come back");
}

beforeAll(async () => {
  await freshWindow();
  ({ key } = await createTenantWithKey("e2e-sealing"));
  expect((await secrets(key, "PUT", "/survives-restart", VALUE)).status).toBe(
    201,
  );
  const uploaded = await upload(key, FILE);
  expect(uploaded.status).toBe(201);
  ({ id: fileId } = (await uploaded.json()) as { id: string });
});

function listFiles() {
  return fetch(`${GATEWAY_URL}/v1/storage/files`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

afterAll(async () => {
  await unsealWith(shares);
});

describe("sealed startup", () => {
  it("is sealed after a restart until 3 shares are entered; meanwhile uploads and downloads get 503 and listing files works", async () => {
    await dockerCompose(["restart", "secrets"]);
    await waitForSecrets();

    expect(await sealStatus()).toMatchObject({
      initialised: true,
      sealed: true,
      progress: 0,
    });
    expect(
      await nodeIn(
        "secrets",
        "fetch('http://127.0.0.1:3002/health').then(r=>console.log(r.status))",
      ),
    ).toBe("200");
    const ready = JSON.parse(
      await nodeIn(
        "secrets",
        "fetch('http://127.0.0.1:3002/ready').then(async r=>console.log(JSON.stringify({s:r.status,b:await r.json()})))",
      ),
    ) as unknown;
    expect(ready).toEqual({
      s: 503,
      b: {
        status: "not_ready",
        reason: "sealed",
        checks: { postgres: "up", seal: "sealed" },
      },
    });
    await expectError(
      await secrets(key, "GET", "/survives-restart"),
      503,
      "SECRETS_SEALED",
    );
    await expectError(
      await secrets(key, "PUT", "/new", "x"),
      503,
      "SECRETS_SEALED",
    );

    expect((await fetch(`${GATEWAY_URL}/ready`)).status).toBe(200);
    await expectError(
      await upload(key, randomBytes(1024)),
      503,
      "SECRETS_SEALED",
    );
    await expectError(
      await download(fileId, `Bearer ${key}`),
      503,
      "SECRETS_SEALED",
    );
    const list = await listFiles();
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { files: { id: string }[] }).files.map(
        (f) => f.id,
      ),
    ).toEqual([fileId]);

    expect((await submitShare(shares[0]!)).status).toMatchObject({
      sealed: true,
      progress: 1,
    });
    expect((await submitShare(shares[0]!)).status).toMatchObject({
      duplicate: true,
      progress: 1,
    });
    expect((await submitShare(shares[3]!)).status).toMatchObject({
      sealed: true,
      progress: 2,
    });
    await expectError(
      await secrets(key, "GET", "/survives-restart"),
      503,
      "SECRETS_SEALED",
    );
    expect((await submitShare(shares[4]!)).status).toMatchObject({
      sealed: false,
    });

    expect(await injectedValue(key, "survives-restart")).toBe(VALUE);
    const downloaded = Buffer.from(
      await (await download(fileId, `Bearer ${key}`)).arrayBuffer(),
    );
    expect(downloaded.equals(FILE)).toBe(true);
  });

  it("a wrong share fails generically and clears progress", async () => {
    await secretsOperator(["seal"]);
    await submitShare(shares[1]!);
    await submitShare(shares[2]!);

    const fake = randomBytes(33);
    fake[32] = Buffer.from(shares[0]!, "base64")[32]!;
    const wrong = await secretsOperator(
      ["unseal"],
      `${fake.toString("base64")}\n`,
    );

    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/Unsealing failed/);
    expect(await sealStatus()).toMatchObject({ sealed: true, progress: 0 });
    await unsealWith(shares);
  });

  it("seal takes effect at once", async () => {
    const sealed = await secretsOperator(["seal"]);
    expect(JSON.parse(sealed.stdout)).toMatchObject({ sealed: true });

    await expectError(
      await secrets(key, "GET", "/survives-restart"),
      503,
      "SECRETS_SEALED",
    );
    await expectError(
      await download(fileId, `Bearer ${key}`),
      503,
      "SECRETS_SEALED",
    );
    expect((await listFiles()).status).toBe(200);

    await unsealWith(shares);
    expect((await secrets(key, "GET", "/survives-restart")).status).toBe(200);
    expect((await download(fileId, `Bearer ${key}`)).status).toBe(200);
  });

  it("refuses shares on the command line", async () => {
    const result = await dockerCompose([
      "exec",
      "-T",
      "secrets",
      "node",
      "dist/operator.js",
      "unseal",
      shares[0]!,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/never accepted on the command line/);
    expect(result.stderr).not.toContain(shares[0]!);
  });
});

describe("operator commands are only reachable inside the secrets container", () => {
  it("not from the gateway's container", async () => {
    const statuses = await nodeIn(
      "gateway",
      `(async () => {
        const out = [];
        for (const path of ["/init", "/unseal", "/seal", "/status", "/operator/status"]) {
          for (const method of ["GET", "POST"]) {
            const r = await fetch("http://secrets:3002" + path, {
              method,
              headers: { "x-tenant-id": "11111111-1111-4111-8111-111111111111", "content-type": "application/json" },
              body: method === "POST" ? "{}" : undefined,
            });
            out.push(r.status);
          }
        }
        console.log(out.join(","));
      })()`,
    );
    const socket = await dockerCompose([
      "exec",
      "-T",
      "gateway",
      "sh",
      "-c",
      "ls /run/secrets-operator 2>&1 || true",
    ]);

    expect(statuses.split(",")).toEqual(
      Array.from({ length: 10 }, () => "404"),
    );
    expect(socket.stdout).toMatch(/No such file or directory/);
  });

  it("not through the public gateway", async () => {
    for (const path of [
      "/init",
      "/unseal",
      "/seal",
      "/status",
      "/admin/unseal",
      "/v1/unseal",
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${GATEWAY_URL}${path}`, {
          method,
          headers: { authorization: `Bearer ${key}` },
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(await response.text()).not.toMatch(
          /"shares"|"progress"|"threshold"/,
        );
      }
    }
    expect((await sealStatus()).sealed).toBe(false);
  });

  it("not from the host (no published port)", async () => {
    await expect(
      fetch("http://127.0.0.1:3002/status", {
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow();
    const container = await dockerCompose(["ps", "--quiet", "secrets"]);
    const id = container.stdout.trim();
    expect(id).not.toBe("");
    const published = spawnSync("docker", ["port", id], { encoding: "utf8" });
    expect(published.status).toBe(0);
    expect(published.stdout.trim()).toBe("");
  });
});

describe("what is stored and logged", () => {
  it("Postgres holds only the encrypted master key: no shares, no readable keys", () => {
    const config = psql(
      "platform",
      "secrets",
      "select share_count, threshold, format_version, length(nonce), length(ciphertext), length(auth_tag) from seal_config",
    );
    const dump = psql(
      "platform",
      "secrets",
      "select * from seal_config; select * from tenant_keys",
    );

    expect(config).toEqual({ ok: true, output: "5|3|1|12|32|16" });
    for (const share of shares) {
      expect(dump.output).not.toContain(share);
      expect(dump.output).not.toContain(
        Buffer.from(share, "base64").toString("hex"),
      );
    }
  });

  it("shares never appear in any container's logs", async () => {
    const logs = (await dockerCompose(["logs", "--no-color"])).stdout;

    expect(logs.length).toBeGreaterThan(0);
    for (const share of shares) {
      expect(logs).not.toContain(share);
      expect(logs).not.toContain(Buffer.from(share, "base64").toString("hex"));
    }
  });
});
