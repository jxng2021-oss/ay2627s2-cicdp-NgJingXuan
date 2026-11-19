import {
  createSecretKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { combine, split } from "shamir-secret-sharing";
import { DecryptionError, open, seal } from "../crypto/aes-gcm.js";
import { FORMAT_VERSION } from "../crypto/envelope.js";
import {
  MasterKeyError,
  SealedError,
  type KeyProvider,
  type SealState,
} from "../crypto/key-provider.js";
import type { Database } from "../db/client.js";
import {
  findSealConfig,
  hasEncryptedData,
  insertSealConfig,
} from "../models/secret.model.js";
import type { SealConfigRow } from "../db/schema.js";
import {
  decodeShare,
  encodeShare,
  InvalidShareError,
  shareNumber,
} from "./shares.js";

export const SHARE_COUNT = 5;
export const THRESHOLD = 3;
const FIRST_MASTER_KEY_VERSION = 1;

export interface SealSettings {
  unsealTimeoutMs: number;
  maxFailedAttempts: number;
  lockoutMs: number;
  drainTimeoutMs: number;
}

export interface SealStatus {
  initialised: boolean;
  sealed: boolean;
  shares: number;
  threshold: number;
  progress: number;
}

export interface UnsealResult extends SealStatus {
  duplicate: boolean;
}

export class AlreadyInitialisedError extends Error {}
export class LeftoverDataError extends Error {}
export class UnsealFailedError extends Error {
  constructor() {
    super("Unsealing failed. Progress was cleared; start again.");
  }
}
export class TooManyAttemptsError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many failed unseal attempts; try again later");
  }
}
export class NotInitialisedError extends Error {
  constructor() {
    super("The secrets service hasn't been initialised yet");
  }
}

function masterKeyContext(
  config: Pick<
    SealConfigRow,
    "formatVersion" | "sealId" | "masterKeyVersion" | "shareCount" | "threshold"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "master-key",
      config.formatVersion,
      config.sealId,
      config.masterKeyVersion,
      config.shareCount,
      config.threshold,
    ]),
  );
}

export type SealAudit = (
  action: "secrets.initialised" | "secrets.unsealed" | "secrets.sealed",
) => Promise<void>;

export class SealManager implements KeyProvider {
  private config: SealConfigRow | undefined;
  private masterKeyBytes: Buffer | undefined;
  private sealing = false;
  private activeRequests = 0;
  private drained: (() => void) | undefined;

  private submitted = new Map<number, Buffer>();
  private progressTimer: NodeJS.Timeout | undefined;
  private failedAttempts = 0;
  private lockedUntil = 0;
  private initialising = false;

  constructor(
    private readonly db: Database,
    private readonly settings: SealSettings,
    private readonly now: () => number = Date.now,
    private readonly audit: SealAudit = () => Promise.resolve(),
  ) {}

  async load(): Promise<void> {
    this.config = await findSealConfig(this.db);
  }

  get state(): SealState {
    if (!this.config) return "uninitialised";
    return this.masterKeyBytes && !this.sealing ? "unsealed" : "sealed";
  }

  get currentVersion(): number {
    return this.config?.masterKeyVersion ?? FIRST_MASTER_KEY_VERSION;
  }

  status(): SealStatus {
    return {
      initialised: this.config !== undefined,
      sealed: this.state !== "unsealed",
      shares: this.config?.shareCount ?? SHARE_COUNT,
      threshold: this.config?.threshold ?? THRESHOLD,
      progress: this.submitted.size,
    };
  }

  masterKey(version: number): KeyObject {
    if (!this.masterKeyBytes) throw new SealedError();
    if (version !== this.currentVersion) {
      throw new MasterKeyError(
        `master key version ${version} is not available`,
      );
    }
    return createSecretKey(this.masterKeyBytes);
  }

  beginRequest(): boolean {
    if (this.state !== "unsealed") return false;
    this.activeRequests++;
    return true;
  }

  endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0) this.drained?.();
  }

  async initialise(): Promise<{ shares: string[]; threshold: number }> {
    if (this.initialising) throw new AlreadyInitialisedError();
    this.initialising = true;
    const masterKey = randomBytes(32);
    const unsealKey = randomBytes(32);
    let shares: Uint8Array[] = [];
    try {
      await this.load();
      if (this.config) throw new AlreadyInitialisedError();
      if (await hasEncryptedData(this.db)) throw new LeftoverDataError();

      const settings = {
        sealId: randomUUID(),
        shareCount: SHARE_COUNT,
        threshold: THRESHOLD,
        masterKeyVersion: FIRST_MASTER_KEY_VERSION,
        formatVersion: FORMAT_VERSION,
      };
      const encrypted = seal(
        createSecretKey(unsealKey),
        masterKey,
        masterKeyContext(settings),
      );
      shares = await withPlainCopy(unsealKey, (secret) =>
        split(secret, SHARE_COUNT, THRESHOLD),
      );
      await checkEveryCombination(
        shares,
        unsealKey,
        masterKey,
        encrypted,
        settings,
      );

      await this.audit("secrets.initialised");
      const saved = await insertSealConfig(this.db, {
        ...settings,
        ...encrypted,
      });
      if (!saved) throw new AlreadyInitialisedError();
      await this.load();
      return { shares: shares.map(encodeShare), threshold: THRESHOLD };
    } finally {
      masterKey.fill(0);
      unsealKey.fill(0);
      for (const share of shares) share.fill(0);
      this.initialising = false;
    }
  }

  async submitShare(text: string): Promise<UnsealResult> {
    if (!this.config) {
      await this.load();
      if (!this.config) throw new NotInitialisedError();
    }
    if (this.state === "unsealed")
      return { ...this.status(), duplicate: false };

    const now = this.now();
    if (now < this.lockedUntil) {
      throw new TooManyAttemptsError(
        Math.ceil((this.lockedUntil - now) / 1000),
      );
    }

    let share: Buffer;
    try {
      share = decodeShare(text);
    } catch (error) {
      this.recordFailure();
      throw error;
    }

    const number = shareNumber(share);
    const existing = this.submitted.get(number);
    if (existing) {
      const same =
        existing.length === share.length && timingSafeEqual(existing, share);
      share.fill(0);
      if (same) return { ...this.status(), duplicate: true };
      this.recordFailure();
      throw new InvalidShareError();
    }

    this.submitted.set(number, share);
    if (this.submitted.size === 1) {
      this.progressTimer = setTimeout(
        () => this.clearProgress(),
        this.settings.unsealTimeoutMs,
      );
      this.progressTimer.unref();
    }
    if (this.submitted.size < this.config.threshold) {
      return { ...this.status(), duplicate: false };
    }

    const config = this.config;
    let unsealKey: Uint8Array | undefined;
    let masterKey: Buffer;
    try {
      const copies = [...this.submitted.values()].map(plainCopy);
      try {
        unsealKey = await combine(copies);
      } finally {
        for (const copy of copies) copy.fill(0);
      }
      masterKey = open(
        createSecretKey(unsealKey),
        config,
        masterKeyContext(config),
      );
    } catch {
      this.recordFailure();
      throw new UnsealFailedError();
    } finally {
      unsealKey?.fill(0);
      this.clearProgress();
    }

    try {
      await this.audit("secrets.unsealed");
    } catch (error) {
      masterKey.fill(0);
      throw error;
    }
    this.masterKeyBytes = masterKey;
    this.sealing = false;
    this.failedAttempts = 0;
    return { ...this.status(), progress: 0, duplicate: false };
  }

  async seal(reason: "operator" | "shutdown" = "operator"): Promise<void> {
    this.clearProgress();
    if (!this.masterKeyBytes) return;
    if (reason === "operator" && !this.sealing) {
      await this.audit("secrets.sealed");
    }
    this.sealing = true;
    if (this.activeRequests > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.settings.drainTimeoutMs);
        timer.unref();
        this.drained = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.drained = undefined;
    }
    this.masterKeyBytes?.fill(0);
    this.masterKeyBytes = undefined;
    this.sealing = false;
  }

  private recordFailure(): void {
    this.failedAttempts++;
    if (this.failedAttempts >= this.settings.maxFailedAttempts) {
      this.failedAttempts = 0;
      this.lockedUntil = this.now() + this.settings.lockoutMs;
      this.clearProgress();
    }
  }

  private clearProgress(): void {
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    for (const share of this.submitted.values()) share.fill(0);
    this.submitted.clear();
  }
}

async function checkEveryCombination(
  shares: Uint8Array[],
  unsealKey: Buffer,
  masterKey: Buffer,
  encrypted: { nonce: Buffer; ciphertext: Buffer; authTag: Buffer },
  settings: Parameters<typeof masterKeyContext>[0],
): Promise<void> {
  for (const group of combinations(shares, THRESHOLD)) {
    const rebuilt = Buffer.from(await combine(group));
    try {
      const opened = open(
        createSecretKey(rebuilt),
        encrypted,
        masterKeyContext(settings),
      );
      const ok = rebuilt.equals(unsealKey) && opened.equals(masterKey);
      opened.fill(0);
      if (!ok) throw new DecryptionError("share check failed");
    } finally {
      rebuilt.fill(0);
    }
  }
}

function plainCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

async function withPlainCopy<T>(
  bytes: Uint8Array,
  use: (copy: Uint8Array) => Promise<T>,
): Promise<T> {
  const copy = plainCopy(bytes);
  try {
    return await use(copy);
  } finally {
    copy.fill(0);
  }
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, i) =>
    combinations(items.slice(i + 1), size - 1).map((rest) => [item, ...rest]),
  );
}
