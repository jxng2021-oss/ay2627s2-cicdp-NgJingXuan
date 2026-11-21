import { beforeAll, describe, expect, it } from "vitest";
import {
  createTenantWithKey,
  expectError,
  freshWindow,
  GATEWAY_URL,
  injectedValue,
  LIMITS,
  psql,
  SECRET_MARKER,
  secrets,
} from "./helpers.js";

beforeAll(freshWindow);

describe("secrets through the gateway", () => {
  it("saves, versions, rotates, lists and deletes; values are never readable", async () => {
    const { key } = await createTenantWithKey("e2e-secrets-flow");
    const v1 = `${SECRET_MARKER}flow-1`;
    const v2 = `${SECRET_MARKER}flow-2`;
    const v3 = `${SECRET_MARKER}flow-3`;

    const created = await secrets(key, "PUT", "/db-password", v1);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "db-password",
      version: 1,
    });
    expect((await secrets(key, "PUT", "/db-password", v2)).status).toBe(200);

    const latest = await secrets(key, "GET", "/db-password");
    expect(latest.headers.get("cache-control")).toBe("no-store");
    const latestText = await latest.text();
    expect(JSON.parse(latestText)).toEqual({
      name: "db-password",
      version: 2,
      createdAt: expect.any(String) as unknown,
    });
    const first = await (
      await secrets(key, "GET", "/db-password?version=1")
    ).text();
    expect(JSON.parse(first)).toMatchObject({ version: 1 });
    expect(latestText + first).not.toContain(SECRET_MARKER);
    expect(await injectedValue(key, "db-password")).toBe(v2);

    const rotated = await secrets(key, "POST", "/db-password/rotate", v3);
    expect(await rotated.json()).toMatchObject({ version: 3 });
    expect(await injectedValue(key, "db-password")).toBe(v3);

    const versions = await (
      await secrets(key, "GET", "/db-password/versions")
    ).text();
    expect(JSON.parse(versions)).toMatchObject({
      versions: [{ version: 3 }, { version: 2 }, { version: 1 }],
      nextCursor: null,
    });
    const list = await (await secrets(key, "GET", "")).text();
    expect(JSON.parse(list)).toMatchObject({
      secrets: [{ name: "db-password", latestVersion: 3 }],
    });
    expect(versions + list).not.toContain(SECRET_MARKER);

    expect((await secrets(key, "DELETE", "/db-password")).status).toBe(204);
    await expectError(
      await secrets(key, "GET", "/db-password"),
      404,
      "NOT_FOUND",
    );
  });

  it("keeps tenants apart: another tenant gets the same 404 as a missing secret", async () => {
    const owner = await createTenantWithKey("e2e-secrets-owner");
    const other = await createTenantWithKey("e2e-secrets-other");
    await secrets(owner.key, "PUT", "/private", `${SECRET_MARKER}private`);

    const attempts = [
      await secrets(other.key, "GET", "/private"),
      await secrets(other.key, "GET", "/private?version=1"),
      await secrets(other.key, "GET", "/private/versions"),
      await secrets(other.key, "POST", "/private/rotate", "hijack"),
      await secrets(other.key, "DELETE", "/private"),
    ];

    for (const response of attempts) {
      const body = await expectError(response, 404, "NOT_FOUND");
      expect(body.error).toMatchObject({ message: "Secret not found" });
    }
    expect(await (await secrets(other.key, "GET", "")).json()).toEqual({
      secrets: [],
      nextCursor: null,
    });
    expect(
      await (await secrets(owner.key, "GET", "/private")).json(),
    ).toMatchObject({
      version: 1,
    });
  });

  it("refuses bad names (400), oversized values (413) and non-JSON bodies (415)", async () => {
    const { key } = await createTenantWithKey("e2e-secrets-limits");

    await expectError(
      await secrets(key, "PUT", "/-bad-name", "v"),
      400,
      "BAD_REQUEST",
    );
    await expectError(
      await secrets(key, "PUT", "/big", "x".repeat(LIMITS.maxSecretBytes + 1)),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    await expectError(
      await fetch(`${GATEWAY_URL}/v1/secrets/text`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "text/plain",
        },
        body: "value",
      }),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(
      (
        await secrets(
          key,
          "PUT",
          "/at-limit",
          "x".repeat(LIMITS.maxSecretBytes),
        )
      ).status,
    ).toBe(201);
  });

  it("gives simultaneous writes different, consecutive versions (real Postgres)", async () => {
    const { key } = await createTenantWithKey("e2e-secrets-concurrent");

    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        secrets(key, "PUT", "/busy", `${SECRET_MARKER}busy-${i}`),
      ),
    );
    const versions = await Promise.all(
      responses.map(
        async (r) => ((await r.json()) as { version: number }).version,
      ),
    );

    expect(versions.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("creates exactly one key for a new tenant, even when its first requests arrive together", async () => {
    const { key, tenantId } = await createTenantWithKey(
      "e2e-secrets-first-key",
    );

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        secrets(key, "PUT", `/first-${i}`, `${SECRET_MARKER}first-${i}`),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(
      Array.from({ length: 12 }, () => 201),
    );
    const keys = psql(
      "platform",
      "secrets",
      `select count(*), count(*) filter (where status = 'active') from tenant_keys where tenant_id = '${tenantId}'`,
    );
    expect(keys).toEqual({ ok: true, output: "1|1" });
  });

  it("stores only ciphertext: the values are unreadable in Postgres", async () => {
    const { key, tenantId } = await createTenantWithKey("e2e-secrets-stored");
    const value = `${SECRET_MARKER}stored-check`;
    await secrets(key, "PUT", "/stored", value);
    await secrets(key, "PUT", "/stored", value);

    const rows = psql(
      "platform",
      "secrets",
      `select v.format_version, v.tenant_key_version, length(v.nonce), length(v.auth_tag), encode(v.ciphertext, 'hex')
       from secret_versions v join secrets s on s.id = v.secret_id
       where s.tenant_id = '${tenantId}' order by v.version`,
    );
    const dump = psql(
      "platform",
      "secrets",
      "select * from secret_versions; select * from tenant_keys",
    );

    expect(rows.ok).toBe(true);
    const [one, two] = rows.output.split("\n").map((line) => line.split("|"));
    expect(one?.slice(0, 4)).toEqual(["1", "1", "12", "16"]);
    expect(one?.[4]).not.toBe(two?.[4]);
    expect(Buffer.from(one?.[4] ?? "", "hex").toString("latin1")).not.toContain(
      SECRET_MARKER,
    );
    expect(dump.ok).toBe(true);
    expect(dump.output).not.toContain(SECRET_MARKER);
  });
});
