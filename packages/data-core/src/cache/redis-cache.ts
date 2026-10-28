import { Redis } from "ioredis";
import { err, ok, type Result } from "../result.js";

/**
 * Redis hot-path cache. Wraps ioredis so every cache miss, hit or outage is a
 * structured result — a Redis outage degrades the system to a cache-bypass, it
 * never throws into the request path.
 *
 * Entries are stored as `{ v: <value>, w: <writtenAtMs> }` so the engine can
 * honour `maxAgeMs` even when the stored TTL is longer.
 */

export interface CacheEntry<T> {
  readonly value: T;
  readonly writtenAtMs: number;
}

interface StoredEnvelope {
  v: unknown;
  w: number;
}

export interface RedisCacheOptions {
  readonly url?: string;
  /** Inject an existing client (tests, shared connections). */
  readonly client?: Redis;
  readonly defaultTtlMs?: number;
}

export class RedisCache {
  private readonly client: Redis;
  private readonly defaultTtlMs: number;

  constructor(options: RedisCacheOptions = {}) {
    this.client =
      options.client ?? new Redis(options.url ?? "redis://localhost:6379", {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });
    this.defaultTtlMs = options.defaultTtlMs ?? 5000;
  }

  async get<T>(key: string, maxAgeMs?: number): Promise<Result<CacheEntry<T> | null>> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return ok(null);
      const parsed = JSON.parse(raw) as StoredEnvelope;
      const age = Date.now() - parsed.w;
      if (maxAgeMs !== undefined && age > maxAgeMs) {
        // Stale relative to this caller's freshness requirement → treat as miss.
        return ok(null);
      }
      return ok({ value: parsed.v as T, writtenAtMs: parsed.w });
    } catch (cause) {
      return err("CACHE_ERROR", "Redis GET failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<Result<void>> {
    try {
      const envelope: StoredEnvelope = { v: value, w: Date.now() };
      const ttl = ttlMs ?? this.defaultTtlMs;
      await this.client.set(key, JSON.stringify(envelope), "PX", ttl);
      return ok(undefined);
    } catch (cause) {
      return err("CACHE_ERROR", "Redis SET failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async invalidate(key: string): Promise<Result<void>> {
    try {
      await this.client.del(key);
      return ok(undefined);
    } catch (cause) {
      return err("CACHE_ERROR", "Redis DEL failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
