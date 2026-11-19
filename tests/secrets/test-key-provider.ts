import { createSecretKey, type KeyObject } from "node:crypto";
import {
  MasterKeyError,
  SealedError,
  type KeyProvider,
  type SealState,
} from "../../services/secrets/src/crypto/key-provider.js";

export class StaticKeyProvider implements KeyProvider {
  readonly currentVersion = 1;
  state: SealState = "unsealed";
  readonly #key: KeyObject;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("a test master key is 32 bytes");
    this.#key = createSecretKey(key);
  }

  masterKey(version: number): KeyObject {
    if (this.state !== "unsealed") throw new SealedError();
    if (version !== this.currentVersion) {
      throw new MasterKeyError(
        `master key version ${version} is not available`,
      );
    }
    return this.#key;
  }

  beginRequest(): boolean {
    return this.state === "unsealed";
  }

  endRequest(): void {}
}

export function testKeyProvider(fill = 1): StaticKeyProvider {
  return new StaticKeyProvider(Buffer.alloc(32, fill));
}
