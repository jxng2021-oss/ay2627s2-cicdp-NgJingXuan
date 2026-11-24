import { Connections } from "./connections.js";
import { SecureCloudError } from "./errors.js";
import { Files } from "./files.js";
import { Flags, flagEnvironment, type FlagEnvironment } from "./flags.js";
import { Http } from "./http.js";
import { UserPool } from "./user-pools.js";
import { Webhooks } from "./webhooks.js";

export interface SecureCloudOptions {
  apiKey?: string;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class SecureCloud {
  readonly connections: Connections;
  readonly files: Files;
  readonly webhooks: Webhooks;
  private readonly http: Http;
  private readonly pools = new Map<string, UserPool>();
  private readonly flagClients = new Map<FlagEnvironment, Flags>();

  constructor(options: SecureCloudOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SECURE_CLOUD_API_KEY;
    if (!apiKey) {
      throw new SecureCloudError(
        0,
        "MISSING_API_KEY",
        "No API key. Set SECURE_CLOUD_API_KEY in your environment (create a key in the dashboard: API keys), or pass { apiKey }.",
      );
    }
    const url = (
      options.url ??
      process.env.SECURE_CLOUD_URL ??
      "http://localhost:8080"
    ).replace(/\/+$/, "");
    if (!/^https?:\/\/[^/\s]+$/.test(url)) {
      throw new SecureCloudError(
        0,
        "INVALID_URL",
        `"${url}" isn't the gateway's address. Use something like http://localhost:8080.`,
      );
    }
    this.http = new Http({
      url,
      apiKey,
      timeoutMs: options.timeoutMs ?? 30_000,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    });
    this.connections = new Connections(this.http);
    this.files = new Files(this.http);
    this.webhooks = new Webhooks(this.http);
  }

  flags(environment?: FlagEnvironment): Flags {
    const name = flagEnvironment(environment);
    let client = this.flagClients.get(name);
    if (!client) {
      client = new Flags(this.http, name);
      this.flagClients.set(name, client);
    }
    return client;
  }

  userPool(poolId: string): UserPool {
    let pool = this.pools.get(poolId);
    if (!pool) {
      pool = new UserPool(this.http, poolId);
      this.pools.set(poolId, pool);
    }
    return pool;
  }

  toJSON(): Record<string, string> {
    return { type: "SecureCloud" };
  }
}

export { SecureCloudError, isSecureCloudError } from "./errors.js";
export { errorHandler } from "./express.js";
export type { CallOptions, ProxyResponse } from "./connections.js";
export type { VerifyOptions, WebhookEvent } from "./webhooks.js";
export type {
  FlagEnvironment,
  FlagResult,
  FlagUser,
  FlagValue,
  Flags,
} from "./flags.js";
export type {
  FileInfo,
  MulterFile,
  UploadOptions,
  UploadSource,
} from "./files.js";
export { hasPermission } from "./user-pools.js";
export type {
  PoolUser,
  Role,
  Session,
  SignedInUser,
  UserPool,
} from "./user-pools.js";
export type {
  ErrorMiddleware,
  Middleware,
  NextFunction,
  RequestLike,
  ResponseLike,
} from "./express.js";
