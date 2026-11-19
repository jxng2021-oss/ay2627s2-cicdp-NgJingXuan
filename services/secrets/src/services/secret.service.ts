import { randomBytes, type KeyObject } from "node:crypto";
import { DecryptionError } from "../crypto/aes-gcm.js";
import {
  decodeWrappedKey,
  decryptValue,
  encodeWrappedKey,
  encryptValue,
  unwrapFileKey,
  unwrapSigningKey,
  unwrapTenantKey,
  wrapFileKey,
  wrapSigningKey,
  wrapTenantKey,
} from "../crypto/envelope.js";
import type { KeyProvider } from "../crypto/key-provider.js";
import type { Database } from "../db/client.js";
import {
  deleteSecret,
  findActiveTenantKey,
  findSecret,
  findTenantKey,
  findVersion,
  insertTenantKeyIfMissing,
  insertVersion,
  isTenantShredded,
  listSecrets,
  listVersions,
  tenantKeyData,
  reserveNextVersion,
  reserveNextVersionOfExisting,
  shredTenant,
} from "../models/secret.model.js";

const FIRST_TENANT_KEY_VERSION = 1;

export interface SavedVersion {
  name: string;
  version: number;
  createdAt: Date;
}

export interface SecretValue extends SavedVersion {
  value: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type BeforeCommit = (saved: SavedVersion) => Promise<void>;
const nothing: BeforeCommit = () => Promise.resolve();

export class TenantShreddedError extends Error {
  constructor() {
    super("this tenant was shredded");
    this.name = "TenantShreddedError";
  }
}

export class SecretService {
  constructor(
    private readonly db: Database,
    private readonly keys: KeyProvider,
  ) {}

  async save(
    tenantId: string,
    name: string,
    value: string,
    beforeCommit: BeforeCommit = nothing,
  ): Promise<SavedVersion> {
    return this.db.transaction(async (tx) => {
      const secret = await reserveNextVersion(tx, tenantId, name);
      const saved = await this.writeVersion(
        tx,
        tenantId,
        secret.id,
        name,
        secret.latestVersion,
        value,
      );
      await beforeCommit(saved);
      return saved;
    });
  }

  async rotate(
    tenantId: string,
    name: string,
    value: string,
    beforeCommit: BeforeCommit = nothing,
  ): Promise<SavedVersion | undefined> {
    return this.db.transaction(async (tx) => {
      const secret = await reserveNextVersionOfExisting(tx, tenantId, name);
      if (!secret) return undefined;
      const saved = await this.writeVersion(
        tx,
        tenantId,
        secret.id,
        name,
        secret.latestVersion,
        value,
      );
      await beforeCommit(saved);
      return saved;
    });
  }

  async describe(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<{ name: string; version: number; createdAt: Date } | undefined> {
    const secret = await findSecret(this.db, tenantId, name);
    if (!secret) return undefined;
    const wanted = version ?? secret.latestVersion;
    const row = await findVersion(this.db, secret.id, wanted);
    return row
      ? { name, version: wanted, createdAt: row.createdAt }
      : undefined;
  }

  async read(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<SecretValue | undefined> {
    const secret = await findSecret(this.db, tenantId, name);
    if (!secret) return undefined;
    const wanted = version ?? secret.latestVersion;
    const row = await findVersion(this.db, secret.id, wanted);
    if (!row) return undefined;

    const tenantKey = await this.existingTenantKey(
      tenantId,
      row.tenantKeyVersion,
    );
    const value = decryptValue(tenantKey, tenantId, name, wanted, {
      formatVersion: row.formatVersion,
      keyVersion: row.tenantKeyVersion,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.authTag,
    });
    return { name, version: wanted, value, createdAt: row.createdAt };
  }

  async list(tenantId: string, limit: number, cursor?: string) {
    const rows = await listSecrets(this.db, tenantId, limit + 1, cursor);
    return page(rows, limit, (last) => last.name);
  }

  async versions(
    tenantId: string,
    name: string,
    limit: number,
    cursor?: number,
  ) {
    const secret = await findSecret(this.db, tenantId, name);
    if (!secret) return undefined;
    const rows = await listVersions(this.db, secret.id, limit + 1, cursor);
    return page(rows, limit, (last) => String(last.version));
  }

  async shred(tenantId: string): Promise<void> {
    await this.db.transaction((tx) => shredTenant(tx, tenantId));
  }

  async delete(
    tenantId: string,
    name: string,
    beforeCommit: () => Promise<void> = () => Promise.resolve(),
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await deleteSecret(tx, tenantId, name);
      if (deleted) await beforeCommit();
      return deleted;
    });
  }

  private async writeVersion(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    tenantId: string,
    secretId: string,
    name: string,
    version: number,
    value: string,
  ): Promise<SavedVersion> {
    const { key, keyVersion } = await this.activeTenantKey(tx, tenantId);
    const encrypted = encryptValue(
      key,
      keyVersion,
      tenantId,
      name,
      version,
      value,
    );
    const createdAt = await insertVersion(tx, secretId, version, encrypted);
    return { name, version, createdAt };
  }

  async wrapFileKey(
    tenantId: string,
    fileId: string,
    fileKey: Buffer,
  ): Promise<Buffer> {
    const { key, keyVersion } = await this.activeTenantKey(this.db, tenantId);
    return encodeWrappedKey(
      wrapFileKey(key, keyVersion, tenantId, fileId, fileKey),
    );
  }

  async wrapSigningKey(
    tenantId: string,
    poolId: string,
    dataKey: Buffer,
  ): Promise<Buffer> {
    const { key, keyVersion } = await this.activeTenantKey(this.db, tenantId);
    return encodeWrappedKey(
      wrapSigningKey(key, keyVersion, tenantId, poolId, dataKey),
    );
  }

  async unwrapSigningKey(
    tenantId: string,
    poolId: string,
    wrapped: Buffer,
  ): Promise<Buffer> {
    const data = decodeWrappedKey(wrapped);
    const tenantKey = await this.existingTenantKey(tenantId, data.keyVersion);
    return unwrapSigningKey(tenantKey, tenantId, poolId, data);
  }

  async unwrapFileKey(
    tenantId: string,
    fileId: string,
    wrapped: Buffer,
  ): Promise<Buffer> {
    const data = decodeWrappedKey(wrapped);
    const tenantKey = await this.existingTenantKey(tenantId, data.keyVersion);
    return unwrapFileKey(tenantKey, tenantId, fileId, data);
  }

  private async activeTenantKey(
    db: Parameters<typeof findActiveTenantKey>[0],
    tenantId: string,
  ): Promise<{ key: KeyObject; keyVersion: number }> {
    let row = await findActiveTenantKey(db, tenantId);
    if (!row) {
      if (await isTenantShredded(db, tenantId)) throw new TenantShreddedError();
      const newKey = randomBytes(32);
      try {
        const wrapped = wrapTenantKey(
          this.keys,
          tenantId,
          FIRST_TENANT_KEY_VERSION,
          newKey,
        );
        await insertTenantKeyIfMissing(
          db,
          tenantId,
          FIRST_TENANT_KEY_VERSION,
          wrapped,
        );
      } finally {
        newKey.fill(0);
      }
      row = await findActiveTenantKey(db, tenantId);
      if (!row) throw new Error("the tenant key was not saved");
    }
    return {
      key: unwrapTenantKey(
        this.keys,
        tenantId,
        row.keyVersion,
        tenantKeyData(row),
      ),
      keyVersion: row.keyVersion,
    };
  }

  private async existingTenantKey(
    tenantId: string,
    keyVersion: number,
  ): Promise<KeyObject> {
    const row = await findTenantKey(this.db, tenantId, keyVersion);
    if (!row) {
      if (await isTenantShredded(this.db, tenantId)) {
        throw new TenantShreddedError();
      }
      throw new DecryptionError("tenant key not found");
    }
    return unwrapTenantKey(this.keys, tenantId, keyVersion, tenantKeyData(row));
  }
}

function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => string,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}
