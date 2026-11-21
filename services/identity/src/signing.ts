import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const KEY_FORMAT_VERSION = 1;

export interface EncryptedPrivateKey {
  formatVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface NewSigningKey {
  kid: string;
  publicJwk: Record<string, string>;
  encrypted: EncryptedPrivateKey;
  dataKey: Buffer;
}

function context(
  tenantId: string,
  poolId: string,
  kid: string,
  version: number,
) {
  return Buffer.from(
    JSON.stringify(["identity-signing-key", version, tenantId, poolId, kid]),
  );
}

export function newSigningKey(tenantId: string, poolId: string): NewSigningKey {
  const kid = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    cipher.setAAD(context(tenantId, poolId, kid, KEY_FORMAT_VERSION));
    const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
    return {
      kid,
      publicJwk: {
        ...(publicKey.export({ format: "jwk" }) as Record<string, string>),
        kid,
        use: "sig",
        alg: "ES256",
      },
      encrypted: {
        formatVersion: KEY_FORMAT_VERSION,
        nonce,
        ciphertext,
        authTag: cipher.getAuthTag(),
      },
      dataKey,
    };
  } finally {
    der.fill(0);
  }
}

export function openSigningKey(
  tenantId: string,
  poolId: string,
  kid: string,
  encrypted: EncryptedPrivateKey,
  dataKey: Buffer,
): KeyObject {
  if (encrypted.formatVersion !== KEY_FORMAT_VERSION) {
    throw new Error(`unknown signing key format ${encrypted.formatVersion}`);
  }
  if (encrypted.authTag.length !== 16) {
    throw new Error("the signing key's authentication tag is the wrong length");
  }
  const decipher = createDecipheriv("aes-256-gcm", dataKey, encrypted.nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(context(tenantId, poolId, kid, encrypted.formatVersion));
  decipher.setAuthTag(encrypted.authTag);
  const der = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

export function signJwt(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

export function verifyJwt(
  token: string,
  keys: Record<string, string>[],
): Record<string, unknown> | undefined {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return undefined;
  const { kid, alg } = JSON.parse(
    Buffer.from(header, "base64url").toString(),
  ) as { kid?: string; alg?: string };
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk || alg !== "ES256") return undefined;
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    {
      key: createPublicKey({ key: jwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signature, "base64url"),
  );
  return ok
    ? (JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
        string,
        unknown
      >)
    : undefined;
}
