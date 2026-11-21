import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createTenantWithKey,
  download,
  expectError,
  freshWindow,
  GATEWAY_URL,
  upload,
} from "./helpers.js";

beforeAll(freshWindow);

describe("client -> gateway -> storage", () => {
  it("serves /health without a key", async () => {
    const response = await fetch(`${GATEWAY_URL}/health`);

    expect(response.status).toBe(200);
  });

  it("is ready, with Postgres and Redis up", async () => {
    const response = await fetch(`${GATEWAY_URL}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { postgres: "up", redis: "up" },
    });
  });

  it("uploads a file with an API key and downloads the same bytes", async () => {
    const { key } = await createTenantWithKey("e2e-uploader");
    const original = randomBytes(5 * 1024 * 1024);

    const uploaded = await upload(key, original);
    expect(uploaded.status).toBe(201);
    const { id, size } = (await uploaded.json()) as {
      id: string;
      size: number;
    };
    expect(size).toBe(original.length);

    const downloaded = await download(id, `Bearer ${key}`);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(original)).toBe(
      true,
    );
  });

  it("keeps tenants apart: tenant B gets 404 for tenant A's file", async () => {
    const a = await createTenantWithKey("e2e-tenant-a");
    const b = await createTenantWithKey("e2e-tenant-b");
    const { id } = (await (
      await upload(a.key, Buffer.from("A's file"))
    ).json()) as { id: string };

    await expectError(await download(id, `Bearer ${b.key}`), 404, "NOT_FOUND");
    expect((await download(id, `Bearer ${a.key}`)).status).toBe(200);
  });

  it("ignores a spoofed X-Tenant-Id header", async () => {
    const a = await createTenantWithKey("e2e-spoofer");
    const b = await createTenantWithKey("e2e-victim");

    const uploaded = await upload(a.key, Buffer.from("spoofed"), {
      "x-tenant-id": b.tenantId,
    });
    const { id } = (await uploaded.json()) as { id: string };

    expect((await download(id, `Bearer ${b.key}`)).status).toBe(404);
    expect((await download(id, `Bearer ${a.key}`)).status).toBe(200);
  });

  it("gives the same 401 for missing, wrong and revoked keys", async () => {
    const { tenantId, keyId, key } = await createTenantWithKey("e2e-revoked");
    const { id } = (await (await upload(key, Buffer.from("x"))).json()) as {
      id: string;
    };
    expect(
      (await admin("DELETE", `/tenants/${tenantId}/api-keys/${keyId}`)).status,
    ).toBe(204);

    const messages = [];
    for (const authorization of [
      undefined,
      `Bearer ${key.slice(0, -1)}x`,
      `Bearer ${key}`,
    ]) {
      const body = await expectError(
        await download(id, authorization),
        401,
        "UNAUTHORIZED",
      );
      messages.push((body.error as { message?: string }).message);
    }
    expect(new Set(messages).size).toBe(1);
  });

  it("protects the admin API", async () => {
    const missing = await fetch(`${GATEWAY_URL}/admin/tenants`, {
      method: "POST",
    });
    const wrong = await fetch(`${GATEWAY_URL}/admin/tenants`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    await expectError(missing, 401, "UNAUTHORIZED");
    await expectError(wrong, 401, "UNAUTHORIZED");
  });

  it("returns 404 in the standard format for a file that doesn't exist", async () => {
    const { key } = await createTenantWithKey("e2e-404");

    await expectError(
      await download("00000000-0000-4000-8000-000000000000", `Bearer ${key}`),
      404,
      "NOT_FOUND",
    );
  });
});
