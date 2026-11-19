export const SHARE_BYTES = 33;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class InvalidShareError extends Error {
  constructor() {
    super("That isn't a valid unseal key share");
    this.name = "InvalidShareError";
  }
}

export function encodeShare(share: Uint8Array): string {
  return Buffer.from(share).toString("base64");
}

export function decodeShare(text: string): Buffer {
  const trimmed = text.trim();
  if (!BASE64.test(trimmed)) throw new InvalidShareError();
  const bytes = Buffer.from(trimmed, "base64");
  if (
    bytes.length !== SHARE_BYTES ||
    bytes.toString("base64") !== trimmed ||
    bytes[SHARE_BYTES - 1] === 0
  ) {
    bytes.fill(0);
    throw new InvalidShareError();
  }
  return bytes;
}

export function shareNumber(share: Buffer): number {
  return share[share.length - 1] ?? 0;
}
