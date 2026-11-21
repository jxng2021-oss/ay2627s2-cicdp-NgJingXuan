import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compose,
  createTenantWithKey,
  download,
  expectError,
  FILE_CONTENT_MARKER,
  FILE_NAME_MARKER,
  freshWindow,
  GATEWAY_URL,
  LIMITS,
  psql,
  upload,
  UUID_PATTERN,
} from "./helpers.js";
import { dockerCompose } from "./operator.js";

interface FileMetadata {
  id: string;
  name: string | null;
  contentType: string;
  size: number;
  createdAt: string;
}

function files(key: string, method: string, path = "") {
  return fetch(`${GATEWAY_URL}/v1/storage${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
}

async function inStorage(script: string): Promise<string> {
  const result = await dockerCompose([
    "exec",
    "-T",
    "storage",
    "sh",
    "-c",
    script,
  ]);
  if (result.code !== 0) throw new Error(`storage: ${result.stderr}`);
  return result.stdout;
}

beforeAll(freshWindow);

describe("encrypted storage", () => {
  it("upload, list, metadata, download (as an attachment), usage and delete", async () => {
    const { key } = await createTenantWithKey("e2e-files");
    const content = Buffer.from(`${FILE_CONTENT_MARKER}hello`);
    const name = `${FILE_NAME_MARKER}report ü.txt`;

    const uploaded = await upload(key, content, {
      "content-type": "text/plain",
      "x-file-name": encodeURIComponent(name),
    });
    expect(uploaded.status).toBe(201);
    const meta = (await uploaded.json()) as FileMetadata;
    expect(meta).toMatchObject({
      name,
      contentType: "text/plain",
      size: content.length,
    });
    expect(meta.id).toMatch(UUID_PATTERN);

    const list = (await (await files(key, "GET", "/files")).json()) as {
      files: FileMetadata[];
    };
    expect(list.files).toEqual([meta]);
    expect(
      await (await files(key, "GET", `/files/${meta.id}/metadata`)).json(),
    ).toEqual(meta);

    const downloaded = await download(meta.id, `Bearer ${key}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloaded.headers.get("content-disposition")).toMatch(
      /^attachment; filename="[^"]+"; filename\*=UTF-8''/,
    );
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(content)).toBe(
      true,
    );

    expect(await (await files(key, "GET", "/usage")).json()).toMatchObject({
      usedBytes: content.length,
      reservedBytes: 0,
    });

    expect((await files(key, "DELETE", `/files/${meta.id}`)).status).toBe(204);
    await expectError(
      await download(meta.id, `Bearer ${key}`),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await files(key, "DELETE", `/files/${meta.id}`),
      404,
      "NOT_FOUND",
    );
    expect(await (await files(key, "GET", "/usage")).json()).toMatchObject({
      usedBytes: 0,
    });
  });

  it("stores only ciphertext on disk, under random names, and downloads unchanged", async () => {
    const { tenantId, key } = await createTenantWithKey("e2e-on-disk");
    const content = Buffer.concat([
      Buffer.from(FILE_CONTENT_MARKER),
      randomBytes(200 * 1024),
      Buffer.from(FILE_CONTENT_MARKER),
    ]);
    const name = `${FILE_NAME_MARKER}secret-plans.pdf`;
    const meta = (await (
      await upload(key, content, { "x-file-name": name })
    ).json()) as FileMetadata;

    const onDisk = (await inStorage(`ls /data/${tenantId}`)).trim().split("\n");
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatch(UUID_PATTERN);
    expect(onDisk[0]).not.toBe(meta.id);
    expect(
      (
        await inStorage(
          `grep -rl '${FILE_CONTENT_MARKER}' /data || true; find /data -name '*${FILE_NAME_MARKER}*'`,
        )
      ).trim(),
    ).toBe("");
    const storedSize = Number(
      (await inStorage(`wc -c < /data/${tenantId}/${onDisk[0]}`)).trim(),
    );
    expect(storedSize).toBeGreaterThan(content.length);

    const downloaded = await download(meta.id, `Bearer ${key}`);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(content)).toBe(
      true,
    );

    const row = psql(
      "storage_app",
      "storage",
      `select original_name, length(encrypted_file_key), status from files where id = '${meta.id}'`,
    );
    expect(row).toEqual({ ok: true, output: `${name}|65|ready` });
  });

  it("keeps tenants apart on every file route", async () => {
    const a = await createTenantWithKey("e2e-files-a");
    const b = await createTenantWithKey("e2e-files-b");
    const { id } = (await (
      await upload(a.key, Buffer.from("A's file"))
    ).json()) as FileMetadata;

    await expectError(await download(id, `Bearer ${b.key}`), 404, "NOT_FOUND");
    await expectError(
      await files(b.key, "GET", `/files/${id}/metadata`),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await files(b.key, "DELETE", `/files/${id}`),
      404,
      "NOT_FOUND",
    );
    expect(await (await files(b.key, "GET", "/files")).json()).toEqual({
      files: [],
      nextCursor: null,
    });
    expect(await (await files(b.key, "GET", "/usage")).json()).toMatchObject({
      usedBytes: 0,
    });
    expect((await download(id, `Bearer ${a.key}`)).status).toBe(200);
  });

  it("enforces the storage limit, also for simultaneous uploads", async () => {
    await freshWindow();
    const { key } = await createTenantWithKey("e2e-quota");
    const usage = (await (await files(key, "GET", "/usage")).json()) as {
      limitBytes: number;
    };
    const size = Math.min(
      LIMITS.maxUploadBytes,
      Math.floor(usage.limitBytes / 3.5),
    );
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => upload(key, randomBytes(size))),
    );
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 201, 201, 413]);
    const refused = results.find((r) => r.status === 413)!;
    await expectError(refused, 413, "STORAGE_QUOTA_EXCEEDED");
    expect(await (await files(key, "GET", "/usage")).json()).toEqual({
      usedBytes: size * 3,
      reservedBytes: 0,
      limitBytes: usage.limitBytes,
    });
  });
});

describe("the secrets service's file-key routes are internal only", () => {
  it("not through the public gateway", async () => {
    const { key } = await createTenantWithKey("e2e-file-keys");
    for (const path of [
      "/internal/file-keys/wrap",
      "/v1/internal/file-keys/unwrap",
      "/v1/secrets/..%2Finternal%2Ffile-keys%2Fwrap",
      "/v1/storage/..%2F..%2Finternal%2Ffile-keys%2Fwrap",
    ]) {
      const response = await fetch(`${GATEWAY_URL}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ fileId: randomBytes(16).toString("hex") }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toMatch(/"key"|"wrappedKey"/);
    }
  });

  it("not from the host (no published port)", async () => {
    await expect(
      fetch("http://127.0.0.1:3002/internal/file-keys/wrap", {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow();
  });

  it("not from another container without storage's token (403)", () => {
    const status = compose(
      "exec",
      "-T",
      "gateway",
      "node",
      "-e",
      `fetch("http://secrets:3002/internal/file-keys/wrap", {
        method: "POST",
        headers: { "x-tenant-id": "11111111-1111-4111-8111-111111111111", "content-type": "application/json", authorization: "Bearer not-the-internal-service-token-000000" },
        body: JSON.stringify({ fileId: "22222222-2222-4222-8222-222222222222", key: "${randomBytes(32).toString("base64")}" }),
      }).then(r => console.log(r.status))`,
    ).trim();

    expect(status).toBe("403");
  });
});
