import { Redis } from "ioredis";

export interface WindowState {
  count: number;
  resetMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<WindowState>;
  peek(key: string): Promise<WindowState>;
  reserve(
    key: string,
    amount: number,
    max: number,
    expiresAtMs: number,
  ): Promise<{ reserved: boolean; total: number }>;
  release(key: string, amount: number): Promise<void>;
  total(key: string): Promise<number>;
  ping(): Promise<void>;
}

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly name: string,
    readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async consume(id: string): Promise<LimitResult> {
    return this.result(await this.store.hit(this.key(id), this.windowMs));
  }

  async isOverLimit(id: string): Promise<LimitResult> {
    const state = await this.store.peek(this.key(id));
    return { ...this.result(state), allowed: state.count < this.limit };
  }

  private key(id: string): string {
    return `ratelimit:${this.name}:${id}`;
  }

  private result({ count, resetMs }: WindowState): LimitResult {
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
    };
  }
}

const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const PEEK_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

const RESERVE_SCRIPT = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if total + amount > tonumber(ARGV[2]) then
  return {0, total}
end
total = redis.call('INCRBY', KEYS[1], amount)
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return {1, total}
`;

const RELEASE_SCRIPT = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
if total <= 0 then return 0 end
local amount = math.min(total, tonumber(ARGV[1]))
return redis.call('DECRBY', KEYS[1], amount)
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowMs: number): Promise<WindowState> {
    return toWindow(await this.redis.eval(HIT_SCRIPT, 1, key, windowMs));
  }

  async peek(key: string): Promise<WindowState> {
    return toWindow(await this.redis.eval(PEEK_SCRIPT, 1, key));
  }

  async reserve(
    key: string,
    amount: number,
    max: number,
    expiresAtMs: number,
  ): Promise<{ reserved: boolean; total: number }> {
    const reply = await this.redis.eval(
      RESERVE_SCRIPT,
      1,
      key,
      amount,
      max,
      expiresAtMs,
    );
    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new Error("Unexpected reply from Redis");
    }
    return { reserved: Number(reply[0]) === 1, total: Number(reply[1]) };
  }

  async release(key: string, amount: number): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, key, amount);
  }

  async total(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}

function toWindow(reply: unknown): WindowState {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error("Unexpected reply from Redis");
  }
  const [count, ttl] = reply.map(Number);
  return { count: count ?? 0, resetMs: Math.max(0, ttl ?? 0) };
}

export function connectRedis(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 500,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  fail = false;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, windowMs: number): Promise<WindowState> {
    if (this.fail) return Promise.reject(new Error("store unavailable"));
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.expiresAt <= now) {
      window = { count: 0, expiresAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return Promise.resolve({
      count: window.count,
      resetMs: window.expiresAt - now,
    });
  }

  peek(key: string): Promise<WindowState> {
    if (this.fail) return Promise.reject(new Error("store unavailable"));
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.expiresAt <= now)
      return Promise.resolve({ count: 0, resetMs: 0 });
    return Promise.resolve({
      count: window.count,
      resetMs: window.expiresAt - now,
    });
  }

  private readonly totals = new Map<
    string,
    { total: number; expiresAt: number }
  >();

  reserve(
    key: string,
    amount: number,
    max: number,
    expiresAtMs: number,
  ): Promise<{ reserved: boolean; total: number }> {
    if (this.fail) return Promise.reject(new Error("store unavailable"));
    const total = this.currentTotal(key);
    if (total + amount > max)
      return Promise.resolve({ reserved: false, total });
    this.totals.set(key, { total: total + amount, expiresAt: expiresAtMs });
    return Promise.resolve({ reserved: true, total: total + amount });
  }

  release(key: string, amount: number): Promise<void> {
    if (this.fail) return Promise.reject(new Error("store unavailable"));
    const entry = this.totals.get(key);
    if (entry) entry.total = Math.max(0, entry.total - amount);
    return Promise.resolve();
  }

  total(key: string): Promise<number> {
    if (this.fail) return Promise.reject(new Error("store unavailable"));
    return Promise.resolve(this.currentTotal(key));
  }

  private currentTotal(key: string): number {
    const entry = this.totals.get(key);
    return entry && entry.expiresAt > this.now() ? entry.total : 0;
  }

  ping(): Promise<void> {
    return this.fail
      ? Promise.reject(new Error("store unavailable"))
      : Promise.resolve();
  }
}
