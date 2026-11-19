import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decryptValue,
  unwrapTenantKey,
  type EncryptedData,
} from "../../services/secrets/src/crypto/envelope.js";
import {
  secrets,
  secretVersions,
  tenantKeys,
} from "../../services/secrets/src/db/schema.js";
import {
  call,
  createTestDatabase,
  startSecrets,
  storedValue,
} from "./helpers.js";
import { StaticKeyProvider } from "./test-key-provider.js";

interface FixtureData {
  formatVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
}
interface Fixture {
  masterKey: { version: number; base64: string; text: string };
  tenantId: string;
  tenantKey: FixtureData & { keyVersion: number; masterKeyVersion: number };
  secrets: {
    name: string;
    versions: (FixtureData & {
      version: number;
      tenantKeyVersion: number;
      expectedValue: string;
    })[];
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("fixtures/compatibility-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

const bytes = (data: FixtureData) => ({
  formatVersion: data.formatVersion,
  nonce: Buffer.from(data.nonce, "hex"),
  ciphertext: Buffer.from(data.ciphertext, "hex"),
  authTag: Buffer.from(data.authTag, "hex"),
});

const keys = new StaticKeyProvider(
  Buffer.from(fixture.masterKey.base64, "base64"),
);

describe("compatibility with data saved by format version 1", () => {
  it("uses the fake test key it says it uses", () => {
    expect(
      Buffer.from(fixture.masterKey.base64, "base64").toString("utf8"),
    ).toBe(fixture.masterKey.text);
    expect(fixture.masterKey.text).toMatch(/^fake-test-/);
  });

  it("decrypts every stored value with the current encryption code", () => {
    const tenantKeyData: EncryptedData = {
      ...bytes(fixture.tenantKey),
      keyVersion: fixture.tenantKey.masterKeyVersion,
    };
    const tenantKey = unwrapTenantKey(
      keys,
      fixture.tenantId,
      fixture.tenantKey.keyVersion,
      tenantKeyData,
    );

    for (const secret of fixture.secrets) {
      for (const v of secret.versions) {
        const value = decryptValue(
          tenantKey,
          fixture.tenantId,
          secret.name,
          v.version,
          { ...bytes(v), keyVersion: v.tenantKeyVersion },
        );
        expect(value).toBe(v.expectedValue);
      }
    }
  });

  it("decrypts every stored value when loaded into the database (the store, and the injection route for the latest)", async () => {
    const { db } = await createTestDatabase();
    await db.insert(tenantKeys).values({
      tenantId: fixture.tenantId,
      keyVersion: fixture.tenantKey.keyVersion,
      masterKeyVersion: fixture.tenantKey.masterKeyVersion,
      ...bytes(fixture.tenantKey),
    });
    for (const secret of fixture.secrets) {
      const [row] = await db
        .insert(secrets)
        .values({
          tenantId: fixture.tenantId,
          name: secret.name,
          latestVersion: secret.versions.length,
        })
        .returning();
      for (const v of secret.versions) {
        await db.insert(secretVersions).values({
          secretId: row?.id ?? "",
          version: v.version,
          tenantKeyVersion: v.tenantKeyVersion,
          ...bytes(v),
        });
      }
    }
    const app = await startSecrets({ db, keyProvider: keys });

    for (const secret of fixture.secrets) {
      for (const v of secret.versions) {
        expect(
          await storedValue(db, fixture.tenantId, secret.name, v.version, keys),
        ).toBe(v.expectedValue);
      }
      const latest = await call(
        app,
        fixture.tenantId,
        "GET",
        `/internal/secrets/${secret.name}`,
      );
      expect(latest.statusCode).toBe(200);
      expect(latest.json<{ value: string }>().value).toBe(
        secret.versions.at(-1)!.expectedValue,
      );
    }
    const added = await call(
      app,
      fixture.tenantId,
      "PUT",
      "/secrets/database-password",
      "new",
    );
    expect(added.json()).toMatchObject({ version: 3 });
  });
});
