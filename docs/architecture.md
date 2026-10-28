# Architecture

This document covers the internals of `@repo/data-core` and how the apps compose it.

## Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `QueryEngine` | `engine/query-engine.ts` | Orchestrates validate → cache → plan → execute → write-back. |
| `RedisCache` | `cache/redis-cache.ts` | Hot-path cache; wraps `ioredis`; outages degrade to bypass. |
| `cacheKey` | `cache/key.ts` | Deterministic, order-insensitive key from `intent` + `params`. |
| `FixedQueryRegistry` | `engine/fixed-queries.ts` | Developer-registered static plans per intent. |
| `Planner` | `mcp/client.ts` | `InProcessPlanner` / `StdioMcpPlanner` → an `ExecutionPlan`. |
| MCP server | `mcp/server.ts` | Node.js MCP server exposing `list_intents` + `plan_query`. |
| `planQuery` | `mcp/planner.ts` | The rules-based planning brain (swap for schema/LLM planning). |
| `executePlan` | `engine/executor.ts` | Runs plan steps in dependency waves across adapters. |
| Adapters | `adapters/*` | `DatabaseAdapter` contract + Postgres (SQL) and Mongo (NoSQL). |

## Request lifecycle

1. **Validate** — `QueryPayloadSchema.parse`. A `ZodError` becomes a
   `VALIDATION_ERROR` result (the gateway validates first with the same schema).
2. **Cache read** — unless `options.forceRefresh`. `maxAgeMs` rejects entries
   older than the caller's tolerance (stored as `{ v, w }` where `w` is the write
   time). A hit returns immediately with `meta.source = "cache"`.
3. **Plan** — if `FixedQueryRegistry.has(intent)`, build that plan
   (`source = "fixed-query"`); otherwise `planner.plan(payload)`
   (`source = "mcp-plan"`).
4. **Execute** — `executePlan` computes ready steps (all `dependsOn` satisfied),
   runs them concurrently, resolves `$ref:` tokens from prior outputs, repeats
   until done, then assembles `plan.shape` (single-row steps are unwrapped).
5. **Write back** — `cache.set(key, data, ttl)` with
   `ttl = maxAgeMs ?? plan.ttlMs ?? defaultTtlMs`, then return `meta` with
   `source`, `cacheKey`, and `durationMs`.

## The `Result<T>` contract

Nothing in the pipeline throws into the caller. Every layer returns:

```ts
type Result<T> =
  | { ok: true;  data: T; meta: ResultMeta }
  | { ok: false; error: { code: ErrorCode; message: string; details?: object }; meta: ResultMeta };
```

`ErrorCode` is a closed union (`VALIDATION_ERROR`, `CACHE_ERROR`, `ADAPTER_ERROR`,
`ADAPTER_NOT_FOUND`, `INTENT_NOT_FOUND`, `PLAN_ERROR`, `PLAN_EXECUTION_ERROR`,
`MCP_UNAVAILABLE`, `INTERNAL_ERROR`). Add codes to the union rather than throwing.

## Execution plans

```ts
interface ExecutionPlan {
  intent: string;
  steps: PlanStep[];              // { id, adapter, op, dependsOn? }
  shape: Record<string, string>; // output field -> step id
  ttlMs?: number;                // planner's caching recommendation
}
```

`$ref:<stepId>.<path>` tokens inside a step's op are resolved from the **first
row** of the referenced step before the op runs — this is how a plan threads,
e.g., an org id fetched in step 1 into step 2's filter. A dependency that can
never be satisfied yields `PLAN_EXECUTION_ERROR` (cycle/unsatisfiable).

## MCP topology

The planner is isolated behind the `Planner` interface:

- **`InProcessPlanner`** calls `planQuery` directly — no IPC. Best for dev/tests
  and single-process services.
- **`StdioMcpPlanner`** uses the MCP SDK's `Client` + `StdioClientTransport` to
  talk to a separate `data-core-mcp` process. This is the deployable topology: one
  planning server can serve many services; it holds no data and no DB handles.

Swap planning strategy (rules → schema-aware → LLM-assisted) by changing only
`mcp/planner.ts`. Callers and plans are unaffected.

## Composition points

- **BFF** (`apps/bff/src/data/data.service.ts`) is the reference assembly: it reads
  env, registers only the adapters whose URLs are present, registers an example
  fixed query, selects the planner by `MCP_TRANSPORT`, and owns one engine for the
  process lifetime.
- **Gateway** (`apps/gateway/src/index.ts`) does edge concerns only — validation
  with the shared schema and routing to the BFF. No business logic, no DB access.
