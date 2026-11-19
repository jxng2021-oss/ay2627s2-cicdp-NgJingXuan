import { createSecretKey, type KeyObject } from "node:crypto";
import { DecryptionError, open, seal } from "./aes-gcm.js";
import { MasterKeyError, type KeyProvider } from "./key-provider.js";

export const FORMAT_VERSION = 1;

export interface EncryptedData {
  formatVersion: number;
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

function tenantKeyContext(
  tenantId: string,
  tenantKeyVersion: number,
  data: Pick<EncryptedData, "formatVersion" | "keyVersion">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "tenant-key",
      data.formatVersion,
      data.keyVersion,
      tenantId,
      tenantKeyVersion,
    ]),
  );
}

function secretValueContext(
  tenantId: string,
  name: string,
  version: number,
  data: Pick<EncryptedData, "formatVersion" | "keyVersion">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "secret-value",
      data.formatVersion,
      data.keyVersion,
      tenantId,
      name,
      version,
    ]),
  );
}

export function wrapTenantKey(
  keys: KeyProvider,
  tenantId: string,
  tenantKeyVersion: number,
  tenantKey: Buffer,
): EncryptedData {
  const header = {
    formatVersion: FORMAT_VERSION,
    keyVersion: keys.currentVersion,
  };
  const sealed = seal(
    keys.masterKey(header.keyVersion),
    tenantKey,
    tenantKeyContext(tenantId, tenantKeyVersion, header),
  );
  return { ...header, ...sealed };
}

export function unwrapTenantKey(
  keys: KeyProvider,
  tenantId: string,
  tenantKeyVersion: number,
  data: EncryptedData,
): KeyObject {
  checkFormat(data);
  let masterKey: KeyObject;
  try {
    masterKey = keys.masterKey(data.keyVersion);
  } catch (error) {
    if (error instanceof MasterKeyError) {
      throw new DecryptionError("master key version not available");
    }
    throw error;
  }
  const plain = open(
    masterKey,
    data,
    tenantKeyContext(tenantId, tenantKeyVersion, data),
  );
  try {
    if (plain.length !== 32) throw new DecryptionError("wrong tenant key size");
    return createSecretKey(plain);
  } finally {
    plain.fill(0);
  }
}

export function encryptValue(
  tenantKey: KeyObject,
  tenantKeyVersion: number,
  tenantId: string,
  name: string,
  version: number,
  value: string,
): EncryptedData {
  const header = {
    formatVersion: FORMAT_VERSION,
    keyVersion: tenantKeyVersion,
  };
  const plain = Buffer.from(value, "utf8");
  try {
    const sealed = seal(
      tenantKey,
      plain,
      secretValueContext(tenantId, name, version, header),
    );
    return { ...header, ...sealed };
  } finally {
    plain.fill(0);
  }
}

export function decryptValue(
  tenantKey: KeyObject,
  tenantId: string,
  name: string,
  version: number,
  data: EncryptedData,
): string {
  checkFormat(data);
  const plain = open(
    tenantKey,
    data,
    secretValueContext(tenantId, name, version, data),
  );
  try {
    return plain.toString("utf8");
  } finally {
    plain.fill(0);
  }
}

function checkFormat(data: EncryptedData): void {
  if (data.formatVersion !== FORMAT_VERSION) {
    throw new DecryptionError(
      `unsupported format version ${data.formatVersion}`,
    );
  }
}

function fileKeyContext(
  tenantId: string,
  fileId: string,
  data: Pick<EncryptedData, "formatVersion" | "keyVersion">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "file-key",
      data.formatVersion,
      data.keyVersion,
      tenantId,
      fileId,
    ]),
  );
}

export function wrapFileKey(
  tenantKey: KeyObject,
  tenantKeyVersion: number,
  tenantId: string,
  fileId: string,
  fileKey: Buffer,
): EncryptedData {
  const header = {
    formatVersion: FORMAT_VERSION,
    keyVersion: tenantKeyVersion,
  };
  const sealed = seal(
    tenantKey,
    fileKey,
    fileKeyContext(tenantId, fileId, header),
  );
  return { ...header, ...sealed };
}

export function unwrapFileKey(
  tenantKey: KeyObject,
  tenantId: string,
  fileId: string,
  data: EncryptedData,
): Buffer {
  checkFormat(data);
  const plain = open(tenantKey, data, fileKeyContext(tenantId, fileId, data));
  if (plain.length !== 32) {
    plain.fill(0);
    throw new DecryptionError("wrong file key size");
  }
  return plain;
}

function signingKeyContext(
  tenantId: string,
  poolId: string,
  data: Pick<EncryptedData, "formatVersion" | "keyVersion">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "signing-key",
      data.formatVersion,
      data.keyVersion,
      tenantId,
      poolId,
    ]),
  );
}

export function wrapSigningKey(
  tenantKey: KeyObject,
  tenantKeyVersion: number,
  tenantId: string,
  poolId: string,
  dataKey: Buffer,
): EncryptedData {
  const header = {
    formatVersion: FORMAT_VERSION,
    keyVersion: tenantKeyVersion,
  };
  const sealed = seal(
    tenantKey,
    dataKey,
    signingKeyContext(tenantId, poolId, header),
  );
  return { ...header, ...sealed };
}

export function unwrapSigningKey(
  tenantKey: KeyObject,
  tenantId: string,
  poolId: string,
  data: EncryptedData,
): Buffer {
  checkFormat(data);
  const plain = open(
    tenantKey,
    data,
    signingKeyContext(tenantId, poolId, data),
  );
  if (plain.length !== 32) {
    plain.fill(0);
    throw new DecryptionError("wrong signing data key size");
  }
  return plain;
}

export function encodeWrappedKey(data: EncryptedData): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(data.formatVersion, 0);
  header.writeUInt32BE(data.keyVersion, 1);
  return Buffer.concat([header, data.nonce, data.authTag, data.ciphertext]);
}

export function decodeWrappedKey(blob: Buffer): EncryptedData {
  if (blob.length !== 5 + 12 + 16 + 32)
    throw new DecryptionError("wrong wrapped key size");
  return {
    formatVersion: blob.readUInt8(0),
    keyVersion: blob.readUInt32BE(1),
    nonce: blob.subarray(5, 17),
    authTag: blob.subarray(17, 33),
    ciphertext: blob.subarray(33),
  };
}
