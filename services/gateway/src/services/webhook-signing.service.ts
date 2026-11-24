import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

export interface WebhookJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

export interface WebhookSigner {
  kid: string;
  sign(body: string, nowMs?: number): string;
  jwks(): { keys: WebhookJwk[] };
}

export function webhookSigner(privateKey: KeyObject): WebhookSigner {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  const kid = createHash("sha256")
    .update(`${jwk.crv}.${jwk.x}.${jwk.y}`)
    .digest("base64url")
    .slice(0, 16);
  return {
    kid,
    sign(body, nowMs = Date.now()) {
      const t = Math.floor(nowMs / 1000);
      const signature = sign("sha256", Buffer.from(`${t}.${body}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `t=${t},kid=${kid},es256=${signature}`;
    },
    jwks: () => ({
      keys: [
        {
          kty: jwk.kty,
          crv: jwk.crv,
          x: jwk.x,
          y: jwk.y,
          kid,
          alg: "ES256",
          use: "sig",
        },
      ],
    }),
  };
}

export function parseWebhookSigningKey(
  value: string | undefined,
  production: boolean,
): KeyObject {
  if (!value?.trim()) {
    if (production) {
      throw new Error(
        "WEBHOOK_SIGNING_KEY must be set: a base64 PKCS#8 EC P-256 private key (deploy.sh generates it)",
      );
    }
    return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: Buffer.from(value.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("WEBHOOK_SIGNING_KEY isn't a base64 PKCS#8 private key");
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("WEBHOOK_SIGNING_KEY must be an EC P-256 key");
  }
  return key;
}
