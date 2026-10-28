# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project: Next.js + Gateway + BFF + MCP Distributed Data-Fetching Framework

## 1. Project Context & Purpose
A data-fetching architecture built entirely in **TypeScript**. It replaces ad-hoc
microservice query code with one standardized request shape resolved through three
layers: an **embedded Redis hot-path cache**, **developer-registered fixed-query
overrides**, and a **self-hosted Model Context Protocol (MCP) server** for dynamic
cross-store query planning.

The framework is a publishable core package (`@repo/data-core`) consumed by an
**Express API gateway**, a **NestJS BFF**, and a **Next.js frontend**.

---

## 2. Monorepo & File Structure
```text
├── apps/
│   ├── web/          # Next.js frontend (App Router, Tailwind) — Global Query console
│   ├── gateway/      # Express API gateway — validates payloads, routes to the BFF
│   └── bff/          # NestJS BFF — assembles and owns the data-core QueryEngine
├── packages/
│   └── data-core/    # Core package: MCP runtime + Redis cache + query engine + adapters
├── docs/             # Architecture and integration guides
└── CLAUDE.md         # This file
```

## 3. Technology Stack
- **Languages:** TypeScript (strict mode across all apps and packages).
- **Core (`packages/data-core`):** `@modelcontextprotocol/sdk`, `ioredis`, and
  optional database drivers `pg` (PostgreSQL) and `mongodb` — declared as
  **optional peer dependencies** and imported lazily, so the package installs
  without them. There is no Prisma dependency.
- **Gateway (`apps/gateway`):** Express; reuses the SDK's Zod schema for edge validation.
- **BFF (`apps/bff`):** NestJS; the single place the engine is wired together.
- **Frontend (`apps/web`):** Next.js (App Router), React, Tailwind CSS.

## 4. Architecture & Execution Flow
1. **Request:** `web` POSTs a Global Query payload to the gateway (`/query`); the
   gateway validates it and forwards to the BFF (`/data/query`).
2. **Hot path (`RedisCache`):** the engine reads Redis using a deterministic key
   derived from `intent` + canonicalized `params` only (`options` are excluded).
   `maxAgeMs` is honored on read; `forceRefresh` skips the read.
3. **Cache miss → plan resolution:**
   - **Fixed-query override:** if an intent is registered in the
     `FixedQueryRegistry`, its hand-compiled plan is used (no planning latency).
   - **MCP plan fallback:** otherwise the `Planner` compiles an `ExecutionPlan`.
     `InProcessPlanner` runs the planner in-process; `StdioMcpPlanner` connects to
     a separate MCP server process over stdio (the customer-hosted topology).
4. **Execution (`executePlan`):** steps run in dependency waves, independent steps
   concurrently, routed to SQL/NoSQL adapters. `$ref:stepId.path` tokens thread one
   step's output into a later step's op.
5. **Write-back:** the assembled result is written to Redis (TTL = `maxAgeMs` ?? the
   plan's `ttlMs` ?? engine default), then returned.

The MCP server holds no data and opens no DB connections — it only emits plans, so
no data leaves the customer's infrastructure through it.

### Key files
- `packages/data-core/src/engine/query-engine.ts` — orchestration (steps 1–5).
- `packages/data-core/src/engine/executor.ts` — plan execution + `$ref` resolution.
- `packages/data-core/src/cache/key.ts` — deterministic, order-insensitive cache key.
- `packages/data-core/src/mcp/{server,client,planner}.ts` — MCP server, client, planner.
- `packages/data-core/src/adapters/*` — `DatabaseAdapter` contract + pg/mongo adapters.
- `apps/bff/src/data/data.service.ts` — where cache + adapters + fixed queries + planner are assembled.

## 5. Global Query Syntax
Validated by `QueryPayloadSchema` (Zod) in `packages/data-core/src/schema.ts`.
`intent` must be snake_case; `params` and `options` default to `{}`.
```json
{
  "intent": "fetch_user_with_active_orders",
  "params": { "userId": "usr_99281a" },
  "options": { "maxAgeMs": 5000, "forceRefresh": false }
}
```

## 6. Development Commands
- `pnpm install` — install workspace dependencies.
- `pnpm --filter @repo/data-core build` — build the core package. **Build this first**;
  the gateway and BFF import its compiled output. The root `pnpm build` enforces this order.
- `pnpm dev` — run all apps/packages in watch mode in parallel.
- `pnpm --filter @repo/bff start:dev` — run the NestJS BFF (default `:4000`).
- `pnpm --filter @repo/gateway dev` — run the Express gateway (default `:8080`).
- `pnpm --filter @repo/web dev` — run the Next.js frontend (`:3000`).
- `pnpm --filter @repo/data-core mcp:server` — run the standalone MCP server over stdio
  (required when `MCP_TRANSPORT=stdio`; build the package first).
- `pnpm typecheck` — type-check every workspace.
- `pnpm test` / `pnpm lint` — **placeholders**: each package's `test`/`lint` script is a
  stub. No test runner or linter is configured yet; wire up vitest/jest + eslint and
  update this section (including how to run a single test) when you do.

Copy `.env.example` to `.env` and set `REDIS_URL`, `POSTGRES_URL`/`MONGO_URL` (adapters
register only when their URL is present), and `MCP_TRANSPORT` (`inprocess` | `stdio`).

## 7. Coding Conventions & Guardrails
- **Strict TypeScript:** no explicit `any`. Validate external input with the Zod schemas.
- **Never throw down the pipeline:** every layer returns a `Result<T>` (`ok`/`err` from
  `result.ts`) with a stable `ErrorCode`. Add new codes to the `ErrorCode` union rather
  than throwing. A Redis outage degrades to a cache bypass; it is not fatal.
- **Adapters stay pluggable:** depend on the `DatabaseAdapter` interface and `AdapterOp`
  union, never on a concrete driver, in the engine/planner. Keep driver imports lazy.
- **Backward compatibility:** when changing the query-parsing layer, keep existing intent
  payloads valid and keep `cacheKey` output stable (a key change silently invalidates caches).
- **No external calls from `data-core`:** the package must not call out to any proprietary
  cloud endpoint; it only touches the configured Redis and databases.
