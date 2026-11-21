import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const LOOKUP_ID_BYTES = 8;
const SECRET_BYTES = 32;

export const API_KEY_PREFIX_PATTERN = /^sk_[a-z0-9]+_$/;
const API_KEY_PATTERN = /^(sk_[a-z0-9]+_[0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface NewApiKey {
  key: string;
  lookupPrefix: string;
  secretHash: string;
}

export function generateApiKey(prefix: string, hashSecret: string): NewApiKey {
  if (!API_KEY_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Invalid API key prefix: ${prefix}`);
  }
  const lookupPrefix = prefix + randomBytes(LOOKUP_ID_BYTES).toString("hex");
  const key = `${lookupPrefix}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { key, lookupPrefix, secretHash: hashApiKey(key, hashSecret) };
}

export function hashApiKey(key: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret).update(key).digest("hex");
}

export function parseApiKey(key: string): { lookupPrefix: string } | undefined {
  const match = API_KEY_PATTERN.exec(key);
  return match?.[1] ? { lookupPrefix: match[1] } : undefined;
}

export function apiKeyMatches(
  key: string,
  storedHash: string,
  hashSecret: string,
): boolean {
  const actual = Buffer.from(hashApiKey(key, hashSecret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  return match?.[1];
}
