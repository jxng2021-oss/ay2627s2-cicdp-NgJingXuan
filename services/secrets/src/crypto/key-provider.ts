import type { KeyObject } from "node:crypto";

export type SealState = "uninitialised" | "sealed" | "unsealed";

export interface KeyProvider {
  readonly state: SealState;
  readonly currentVersion: number;
  masterKey(version: number): KeyObject;
  beginRequest(): boolean;
  endRequest(): void;
}

export class SealedError extends Error {
  constructor(message = "The secrets service is sealed") {
    super(message);
    this.name = "SealedError";
  }
}

export class MasterKeyError extends Error {}
