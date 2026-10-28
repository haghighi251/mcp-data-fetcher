import { ZodError } from "zod";
import { AdapterRegistry } from "../adapters/types.js";
import { RedisCache } from "../cache/redis-cache.js";
import { cacheKey } from "../cache/key.js";
import { InProcessPlanner, type Planner } from "../mcp/client.js";
import { executePlan } from "./executor.js";
import { FixedQueryRegistry } from "./fixed-queries.js";
import { QueryPayloadSchema, type QueryPayload } from "../schema.js";
import { err, ok, type Result } from "../result.js";

/**
 * The orchestrator. Implements the architecture's execution flow:
 *
 *   1. Validate the Global Query payload (Zod).
 *   2. Hot path: read Redis (unless forceRefresh), honouring maxAgeMs.
 *   3. Cache miss:
 *        a. Fixed-query override  → compile the registered plan.
 *        b. Otherwise             → ask the MCP planner to compile a plan.
 *   4. Execute the plan across SQL/NoSQL adapters (concurrently where possible).
 *   5. Write the result back to Redis, then return it.
 *
 * Every branch returns a structured Result; nothing throws into the caller.
 */

export interface QueryEngineOptions {
  readonly cache: RedisCache;
  readonly adapters: AdapterRegistry;
  readonly fixedQueries?: FixedQueryRegistry;
  /** Defaults to an in-process planner. Pass a StdioMcpPlanner for the MCP topology. */
  readonly planner?: Planner;
  readonly cachePrefix?: string;
  readonly defaultTtlMs?: number;
}

export class QueryEngine {
  private readonly cache: RedisCache;
  private readonly adapters: AdapterRegistry;
  private readonly fixedQueries: FixedQueryRegistry;
  private readonly planner: Planner;
  private readonly cachePrefix: string;
  private readonly defaultTtlMs: number;

  constructor(options: QueryEngineOptions) {
    this.cache = options.cache;
    this.adapters = options.adapters;
    this.fixedQueries = options.fixedQueries ?? new FixedQueryRegistry();
    this.planner = options.planner ?? new InProcessPlanner();
    this.cachePrefix = options.cachePrefix ?? "dcore";
    this.defaultTtlMs = options.defaultTtlMs ?? 5000;
  }

  async query<T = Record<string, unknown>>(input: unknown): Promise<Result<T>> {
    const started = Date.now();

    // 1. Validate.
    let payload: QueryPayload;
    try {
      payload = QueryPayloadSchema.parse(input);
    } catch (cause) {
      return err(
        "VALIDATION_ERROR",
        "Invalid Global Query payload",
        cause instanceof ZodError ? { details: { issues: cause.issues } } : {},
      );
    }

    const key = cacheKey(payload, this.cachePrefix);

    // 2. Hot path.
    if (!payload.options.forceRefresh) {
      const cached = await this.cache.get<T>(key, payload.options.maxAgeMs);
      if (cached.ok && cached.data !== null) {
        return ok(cached.data.value, {
          source: "cache",
          cacheKey: key,
          durationMs: Date.now() - started,
        });
      }
      // A CACHE_ERROR here is non-fatal: we degrade to a cache bypass.
    }

    // 3. Resolve a plan: fixed-query override first, then MCP planner.
    const source = this.fixedQueries.has(payload.intent) ? "fixed-query" : "mcp-plan";
    const planResult =
      source === "fixed-query"
        ? okPlanFromFixed(this.fixedQueries, payload)
        : await this.planner.plan(payload);
    if (!planResult.ok) {
      return { ...planResult, meta: { ...planResult.meta, cacheKey: key } };
    }

    // 4. Execute across adapters.
    const executed = await executePlan(planResult.data, this.adapters);
    if (!executed.ok) {
      return { ...executed, meta: { ...executed.meta, cacheKey: key } };
    }

    // 5. Write back (best-effort) and return.
    const ttl = payload.options.maxAgeMs ?? planResult.data.ttlMs ?? this.defaultTtlMs;
    await this.cache.set(key, executed.data, ttl);

    return ok(executed.data as T, {
      source,
      cacheKey: key,
      durationMs: Date.now() - started,
    });
  }

  /** Explicitly drop a cached intent (e.g. after a mutation). */
  async invalidate(input: unknown): Promise<Result<void>> {
    let payload: QueryPayload;
    try {
      payload = QueryPayloadSchema.parse(input);
    } catch {
      return err("VALIDATION_ERROR", "Invalid Global Query payload");
    }
    return this.cache.invalidate(cacheKey(payload, this.cachePrefix));
  }

  async close(): Promise<void> {
    await Promise.all([
      this.cache.close(),
      this.adapters.closeAll(),
      this.planner.close?.(),
    ]);
  }
}

function okPlanFromFixed(
  registry: FixedQueryRegistry,
  payload: QueryPayload,
): Result<import("../plan.js").ExecutionPlan> {
  const plan = registry.build(payload);
  if (!plan) {
    return err("INTENT_NOT_FOUND", `No fixed query for intent '${payload.intent}'`);
  }
  return ok(plan);
}
