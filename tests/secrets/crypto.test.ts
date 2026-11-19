import { createSecretKey, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTH_TAG_BYTES,
  DecryptionError,
  NONCE_BYTES,
  open,
  seal,
} from "../../services/secrets/src/crypto/aes-gcm.js";
import {
  decryptValue,
  encryptValue,
  unwrapTenantKey,
  wrapTenantKey,
  type EncryptedData,
} from "../../services/secrets/src/crypto/envelope.js";
import { testKeyProvider } from "./helpers.js";

const key = () => createSecretKey(randomBytes(32));
const aad = Buffer.from("context");
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function flipBit(buffer: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe("AES-256-GCM", () => {
  it.each([0, 1, 15, 16, 17, 1000, 64 * 1024, 1024 * 1024])(
    "encrypts and decrypts %i bytes",
    (size) => {
      const k = key();
      const plaintext = randomBytes(size);

      const sealed = seal(k, plaintext, aad);

      expect(sealed.nonce).toHaveLength(NONCE_BYTES);
      expect(sealed.authTag).toHaveLength(AUTH_TAG_BYTES);
      expect(sealed.ciphertext).toHaveLength(size);
      expect(open(k, sealed, aad).equals(plaintext)).toBe(true);
    },
  );

  it("produces different output every time for the same value (new nonce)", () => {
    const k = key();
    const plaintext = Buffer.from("same value");

    const outputs = Array.from({ length: 50 }, () => seal(k, plaintext, aad));

    expect(new Set(outputs.map((o) => o.nonce.toString("hex"))).size).toBe(50);
    expect(new Set(outputs.map((o) => o.ciphertext.toString("hex"))).size).toBe(
      50,
    );
  });

  it("never contains the plaintext", () => {
    const plaintext = Buffer.from(
      "a very recognisable secret value ".repeat(10),
    );
    const sealed = seal(key(), plaintext, aad);

    expect(sealed.ciphertext.includes(Buffer.from("recognisable"))).toBe(false);
  });

  it.each(["ciphertext", "nonce", "authTag"] as const)(
    "rejects a changed %s",
    (field) => {
      const k = key();
      const sealed = seal(k, Buffer.from("value"), aad);
      const changed = { ...sealed, [field]: flipBit(sealed[field]) };

      expect(() => open(k, changed, aad)).toThrow(DecryptionError);
    },
  );

  it("rejects a shortened auth tag or nonce", () => {
    const k = key();
    const sealed = seal(k, Buffer.from("value"), aad);
    const shortTag = { ...sealed, authTag: sealed.authTag.subarray(0, 12) };
    const shortNonce = { ...sealed, nonce: sealed.nonce.subarray(0, 8) };

    expect(() => open(k, shortTag, aad)).toThrow(DecryptionError);
    expect(() => open(k, shortNonce, aad)).toThrow(DecryptionError);
  });

  it("rejects a different context (AAD) or key", () => {
    const k = key();
    const sealed = seal(k, Buffer.from("value"), aad);

    expect(() => open(k, sealed, Buffer.from("other context"))).toThrow(
      DecryptionError,
    );
    expect(() => open(key(), sealed, aad)).toThrow(DecryptionError);
  });
});

describe("envelope encryption", () => {
  const keys = testKeyProvider();
  const newTenantKey = (tenantId: string) =>
    unwrapTenantKey(
      keys,
      tenantId,
      1,
      wrapTenantKey(keys, tenantId, 1, randomBytes(32)),
    );

  it.each([
    "",
    "x",
    "p@ssw0rd!",
    "multi\nline\tvalue",
    "ünïcödé \u{1F511} 秘密",
    "x".repeat(65536),
  ])("round-trips secret values (%#)", (value) => {
    const tenantKey = newTenantKey(TENANT_A);

    const data = encryptValue(tenantKey, 1, TENANT_A, "db-password", 3, value);

    expect(data.formatVersion).toBe(1);
    expect(data.keyVersion).toBe(1);
    expect(decryptValue(tenantKey, TENANT_A, "db-password", 3, data)).toBe(
      value,
    );
  });

  it("binds a tenant key to its tenant and key version", () => {
    const wrapped = wrapTenantKey(keys, TENANT_A, 1, randomBytes(32));

    expect(() => unwrapTenantKey(keys, TENANT_B, 1, wrapped)).toThrow(
      DecryptionError,
    );
    expect(() => unwrapTenantKey(keys, TENANT_A, 2, wrapped)).toThrow(
      DecryptionError,
    );
  });

  it("refuses a tenant key wrapped by a different master key", () => {
    const wrapped = wrapTenantKey(keys, TENANT_A, 1, randomBytes(32));

    expect(() =>
      unwrapTenantKey(testKeyProvider(2), TENANT_A, 1, wrapped),
    ).toThrow(DecryptionError);
  });

  it("refuses an unknown master key version", () => {
    const wrapped = wrapTenantKey(keys, TENANT_A, 1, randomBytes(32));

    expect(() =>
      unwrapTenantKey(keys, TENANT_A, 1, { ...wrapped, keyVersion: 2 }),
    ).toThrow(/master key version not available/);
  });

  describe("a value copied to another context is rejected", () => {
    const tenantKey = createSecretKey(randomBytes(32));
    const data = encryptValue(tenantKey, 1, TENANT_A, "api-token", 2, "value");

    it.each([
      ["another tenant", TENANT_B, "api-token", 2],
      ["another name", TENANT_A, "other-token", 2],
      ["another version", TENANT_A, "api-token", 1],
    ] as const)("%s", (_case, tenantId, name, version) => {
      expect(() =>
        decryptValue(tenantKey, tenantId, name, version, data),
      ).toThrow(DecryptionError);
    });

    it("while the original still decrypts", () => {
      expect(decryptValue(tenantKey, TENANT_A, "api-token", 2, data)).toBe(
        "value",
      );
    });
  });

  it("rejects changed format or key version headers", () => {
    const tenantKey = createSecretKey(randomBytes(32));
    const data = encryptValue(tenantKey, 1, TENANT_A, "n", 1, "v");
    const changed = (patch: Partial<EncryptedData>) => ({ ...data, ...patch });

    expect(() =>
      decryptValue(tenantKey, TENANT_A, "n", 1, changed({ formatVersion: 2 })),
    ).toThrow(/unsupported format version/);
    expect(() =>
      decryptValue(tenantKey, TENANT_A, "n", 1, changed({ keyVersion: 2 })),
    ).toThrow(DecryptionError);
  });
});
