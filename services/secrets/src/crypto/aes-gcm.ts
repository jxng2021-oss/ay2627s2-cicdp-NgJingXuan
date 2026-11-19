import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;

export interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`decryption failed: ${reason}`);
    this.name = "DecryptionError";
  }
}

export function seal(key: KeyObject, plaintext: Buffer, aad: Buffer): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function open(key: KeyObject, sealed: Sealed, aad: Buffer): Buffer {
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new DecryptionError("wrong nonce length");
  }
  if (sealed.authTag.length !== AUTH_TAG_BYTES) {
    throw new DecryptionError("wrong auth tag length");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new DecryptionError("authentication failed");
  }
}
