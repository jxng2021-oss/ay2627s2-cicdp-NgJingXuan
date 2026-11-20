import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuditRow } from "./db/schema.js";

export const GENESIS_HASH = "0".repeat(64);
const HASH_VERSION = "audit-v1";

export type HashedFields = Omit<AuditRow, "hash">;

export function computeHash(key: string, entry: HashedFields): string {
  const message = JSON.stringify([
    HASH_VERSION,
    entry.id,
    entry.chain,
    entry.seq,
    entry.occurredAt.toISOString(),
    entry.tenantId,
    entry.service,
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.outcome,
    entry.requestId,
    entry.sourceIp,
    entry.prevHash,
  ]);
  return createHmac("sha256", key).update(message).digest("hex");
}

export function hashMatches(key: string, entry: AuditRow): boolean {
  const expected = Buffer.from(computeHash(key, entry), "hex");
  const stored = Buffer.from(entry.hash, "hex");
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}

export interface Broken {
  seq: number;
  id: string | null;
  reason: string;
}

export interface VerifyResult {
  chain: string;
  ok: boolean;
  checked: number;
  firstBroken?: Broken;
}

export class ChainVerifier {
  private expectedSeq = 1;
  private previousHash = GENESIS_HASH;
  private broken: Broken | undefined;
  private checked = 0;

  constructor(
    private readonly key: string,
    private readonly chain: string,
  ) {}

  check(entries: AuditRow[]): boolean {
    for (const entry of entries) {
      const problem = this.problemWith(entry);
      if (problem) {
        this.broken = { seq: entry.seq, id: entry.id, reason: problem };
        return false;
      }
      this.checked++;
      this.expectedSeq++;
      this.previousHash = entry.hash;
    }
    return true;
  }

  result(): VerifyResult {
    return {
      chain: this.chain,
      ok: this.broken === undefined,
      checked: this.checked,
      ...(this.broken ? { firstBroken: this.broken } : {}),
    };
  }

  private problemWith(entry: AuditRow): string | undefined {
    if (entry.chain !== this.chain) return "the entry belongs to another chain";
    if (entry.seq !== this.expectedSeq) {
      return entry.seq > this.expectedSeq
        ? `entry ${this.expectedSeq} is missing (the next one is ${entry.seq})`
        : `entry ${entry.seq} appears twice or out of order`;
    }
    if (entry.prevHash !== this.previousHash) {
      return "its link to the previous entry doesn't match (an earlier entry was changed, removed or reordered)";
    }
    if (!hashMatches(this.key, entry)) {
      return "its hash doesn't match its contents (the entry was changed)";
    }
    return undefined;
  }
}
