import { describe, expect, it } from "vitest";
import {
  apiKeyMatches,
  bearerToken,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  secretsEqual,
} from "../../services/gateway/src/services/api-key-tokens.service.js";

const SECRET = "test-hash-secret-0123456789abcdef0123456789";

describe("API key helpers", () => {
  it("generates keys with a recognisable prefix and 256 bits of secret", () => {
    const { key, lookupPrefix } = generateApiKey("sk_local_", SECRET);

    expect(key).toMatch(/^sk_local_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`${lookupPrefix}_`)).toBe(true);
    expect(Buffer.from(key.slice(-43), "base64url")).toHaveLength(32);
  });

  it("stores an HMAC-SHA-256 hash, not the key", () => {
    const { key, secretHash } = generateApiKey("sk_local_", SECRET);

    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secretHash).not.toContain(key);
    expect(secretHash).toBe(hashApiKey(key, SECRET));
  });

  it("depends on the server-side secret", () => {
    const { key } = generateApiKey("sk_local_", SECRET);

    expect(hashApiKey(key, SECRET)).not.toBe(hashApiKey(key, `${SECRET}x`));
  });

  it("matches only the right key", () => {
    const { key, secretHash } = generateApiKey("sk_local_", SECRET);

    expect(apiKeyMatches(key, secretHash, SECRET)).toBe(true);
    expect(apiKeyMatches(`${key}x`, secretHash, SECRET)).toBe(false);
    expect(apiKeyMatches(key, secretHash, `${SECRET}x`)).toBe(false);
    expect(apiKeyMatches(key, "not-a-hash", SECRET)).toBe(false);
  });

  it("parses only well-formed keys", () => {
    const { key, lookupPrefix } = generateApiKey("sk_local_", SECRET);

    expect(parseApiKey(key)).toEqual({ lookupPrefix });
    expect(parseApiKey("sk_local_abc")).toBeUndefined();
    expect(parseApiKey(`${key}!`)).toBeUndefined();
    expect(parseApiKey("")).toBeUndefined();
  });

  it("rejects an invalid prefix", () => {
    expect(() => generateApiKey("local", SECRET)).toThrow();
  });

  it("compares secrets of any length", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });

  it("reads bearer tokens", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
