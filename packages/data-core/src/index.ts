/**
 * @repo/data-core — public SDK surface.
 *
 * Consumers (the NestJS BFF, standalone microservices) import from here to build
 * a QueryEngine, register adapters and fixed queries, and run Global Query
 * payloads. The MCP server runtime is published separately at
 * `@repo/data-core/mcp/server`.
 */

// Core types & helpers
export * from "./result.js";
export * from "./schema.js";
export * from "./plan.js";

// Cache
export { RedisCache } from "./cache/redis-cache.js";
export type { CacheEntry, RedisCacheOptions } from "./cache/redis-cache.js";
export { cacheKey } from "./cache/key.js";

// Adapters
export { AdapterRegistry } from "./adapters/types.js";
export type {
  AdapterOp,
  SqlOp,
  NoSqlOp,
  DatabaseAdapter,
} from "./adapters/types.js";
export { PostgresAdapter } from "./adapters/postgres-adapter.js";
export type { PostgresAdapterOptions } from "./adapters/postgres-adapter.js";
export { MongoAdapter } from "./adapters/mongo-adapter.js";
export type { MongoAdapterOptions } from "./adapters/mongo-adapter.js";

// Planning / MCP
export { InProcessPlanner, StdioMcpPlanner } from "./mcp/client.js";
export type { Planner, StdioMcpPlannerOptions } from "./mcp/client.js";
export { planQuery, describeIntents } from "./mcp/planner.js";
export type { IntentDescriptor, PlanOutcome } from "./mcp/planner.js";

// Engine
export { QueryEngine } from "./engine/query-engine.js";
export type { QueryEngineOptions } from "./engine/query-engine.js";
export { FixedQueryRegistry } from "./engine/fixed-queries.js";
export type { FixedQueryBuilder } from "./engine/fixed-queries.js";
export { executePlan } from "./engine/executor.js";
