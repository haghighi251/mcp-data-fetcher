# MCP Data Fetcher

A distributed data-fetching framework for TypeScript backends. It replaces the
per-service tangle of hand-written queries, ad-hoc caches, and copy-pasted join
logic with **one request shape** resolved through a predictable three-layer
engine:

```
Redis hot-path  →  Fixed-query override  →  MCP dynamic plan  →  SQL + NoSQL
   (<~2ms)          (deterministic)          (Node.js planner)    (concurrent)
```

Every service — frontend, gateway, BFF, or a standalone microservice — asks for
data the same way: a **Global Query** payload describing *intent*, not SQL.

```json
{
  "intent": "fetch_user_with_active_orders",
  "params": { "userId": "usr_99281a" },
  "options": { "maxAgeMs": 5000, "forceRefresh": false }
}
```

---

## The problem it fixes

In a microservice estate, a single screen often needs data from several stores.
Teams usually solve this by scattering query logic everywhere:

- The same user+orders join is reimplemented in three services, slightly differently.
- Each service bolts on its own Redis caching with inconsistent keys and TTLs.
- "Hot" endpoints need hand-tuned queries, but "long-tail" endpoints need
  flexibility — and there's no clean place to put either.
- Cross-store reads (Postgres user + Mongo orders) become bespoke glue code.

**MCP Data Fetcher centralizes the *how* behind a stable *what*.** Services declare
an `intent`; the framework decides how to resolve it — cache, a reviewed fixed
query, or a dynamically compiled plan — and executes it across SQL and NoSQL
stores for you. The query logic lives in one place (`data-core`), caching is
uniform and deterministic, and swapping the resolution strategy for an intent
never changes the caller.

---

## Architecture

```text
┌──────────────┐   Global Query    ┌──────────────┐   /data/query   ┌───────────────────────┐
│  Next.js web │ ───────────────▶  │ Express GW   │ ──────────────▶ │ NestJS BFF            │
│ (App Router) │   POST /query     │ validate+route│                │  owns the QueryEngine │
└──────────────┘                   └──────────────┘                 └───────────┬───────────┘
                                                                                 │
                                                        ┌────────────────────────▼────────────────────────┐
                                                        │             @repo/data-core (SDK)                 │
                                                        │                                                   │
                                                        │   1) RedisCache ── hot path (deterministic key)   │
                                                        │   2) FixedQueryRegistry ── reviewed static plan   │
                                                        │   3) Planner ── dynamic ExecutionPlan             │
                                                        │        • InProcessPlanner                         │
                                                        │        • StdioMcpPlanner ──▶ MCP server (Node.js) │
                                                        │   4) executePlan ── dependency waves, concurrent  │
                                                        └───────┬───────────────────────────────┬──────────┘
                                                                │                               │
                                                        ┌───────▼────────┐             ┌────────▼────────┐
                                                        │ PostgresAdapter │             │   MongoAdapter   │
                                                        │   (SQL, pg)     │             │  (NoSQL, mongodb)│
                                                        └─────────────────┘             └──────────────────┘
```

### The resolution flow (what happens on every request)

1. **Validate** — the Global Query payload is parsed with a shared Zod schema at
   the gateway *and* in the engine. Malformed input never reaches a database.
2. **Redis hot path** — a deterministic key is built from `intent` +
   canonicalized `params` (object key order doesn't matter; `options` are
   excluded so the same data shares a slot). `maxAgeMs` enforces freshness on
   read; `forceRefresh` bypasses it. A Redis outage degrades to a cache bypass —
   it never throws into the request.
3. **Fixed-query override** — if the intent is registered in the
   `FixedQueryRegistry`, its hand-compiled, reviewed plan runs directly. This is
   the "bulletproof production" path: zero planning latency, fully deterministic.
4. **MCP dynamic plan** — otherwise the planner compiles an `ExecutionPlan`. It
   runs either in-process or in a separate **MCP server over stdio** (see below).
5. **Execute** — `executePlan` runs steps in dependency *waves*: independent
   steps run concurrently; `$ref:stepId.path` tokens thread one step's output
   into a later step. Each step is routed to the adapter that owns it.
6. **Write back** — the assembled result is cached (TTL = `maxAgeMs` ?? the
   plan's recommended `ttlMs` ?? engine default) and returned.

Every layer returns a structured `Result<T>` — `{ ok: true, data, meta }` or
`{ ok: false, error: { code, message }, meta }` — so callers branch on data, never
on thrown exceptions. `meta.source` (`cache` | `fixed-query` | `mcp-plan`) tells you
exactly which path served the response.

---

## Flexible across SQL and NoSQL

The engine and planner never speak a database dialect. They speak **`AdapterOp`s**:

```ts
type SqlOp   = { kind: "sql"; text: string; values?: unknown[] };
type NoSqlOp = { kind: "nosql"; collection: string; operation: "find" | "findOne";
                 filter: Record<string, unknown>; projection?: ...; limit?: number };
```

An **adapter** translates ops into real driver calls and returns rows as a
`Result`. Two ship in the box:

- `PostgresAdapter` (SQL, via `pg`)
- `MongoAdapter` (NoSQL, via `mongodb`)

Both drivers are **optional peer dependencies, imported lazily** — install only
what you use; a missing driver surfaces as a structured `ADAPTER_ERROR`, not a
crash. Adding a third store (MySQL, DynamoDB, Elasticsearch, a REST service…) is
just implementing the `DatabaseAdapter` interface and registering it:

```ts
const adapters = new AdapterRegistry()
  .register(new PostgresAdapter({ connectionString: process.env.POSTGRES_URL! }))
  .register(new MongoAdapter({ url: process.env.MONGO_URL!, database: "app" }));
```

Because a single plan can mix adapters, one intent (`fetch_user_with_active_orders`)
reads the user from **Postgres** and their active orders from **MongoDB** —
concurrently — and returns them as one shaped object. The caller never knows two
stores were involved.

---

## The MCP part: Redis + Node.js

Dynamic query planning runs as a **self-hosted MCP (Model Context Protocol)
server written in Node.js** (`packages/data-core/src/mcp/server.ts`). It exposes
two tools over stdio:

- `list_intents` — advertises which intents it can compile (and their required params).
- `plan_query` — compiles a Global Query payload into a concrete `ExecutionPlan`.

Crucially, **the MCP server holds no data and opens no database connections** — it
only emits plans. The actual fetching and the **Redis** cache live in the engine
beside your adapters. That separation is what keeps data on your infrastructure:
planning is a pure function of intent → plan; execution and caching never leave
your process.

Two ways to run the planner, chosen with `MCP_TRANSPORT`:

| Mode        | How                                             | Use for                          |
|-------------|-------------------------------------------------|----------------------------------|
| `inprocess` | `InProcessPlanner` calls the planner directly   | local dev, tests, single process |
| `stdio`     | `StdioMcpPlanner` spawns/connects the MCP server | the customer-hosted topology     |

Run the server standalone:

```bash
pnpm --filter @repo/data-core build
pnpm --filter @repo/data-core mcp:server    # speaks MCP over stdio
```

The planner shipped here is deterministic and rules-based — a clean seam where you
plug in schema-aware or LLM-assisted planning without touching any caller.

---

## Repository layout

```text
apps/
  web/        Next.js frontend — a live Global Query console
  gateway/    Express API gateway — edge validation + routing to the BFF
  bff/        NestJS BFF — assembles and owns the QueryEngine
packages/
  data-core/  the framework: cache, engine, executor, adapters, MCP server/client
docs/         architecture notes + microservice integration guide
```

See **[docs/architecture.md](docs/architecture.md)** for internals and
**[docs/microservice-integration.md](docs/microservice-integration.md)** for
embedding `data-core` directly in a service.

---

## Quick start

> Prerequisites: Node ≥ 20, pnpm 9, and a reachable Redis. Postgres/Mongo are
> optional — adapters register only when their URL is set.

```bash
pnpm install
cp .env.example .env            # set REDIS_URL, optionally POSTGRES_URL / MONGO_URL
pnpm --filter @repo/data-core build

# terminal 1 — BFF (:4000)
pnpm --filter @repo/bff start:dev
# terminal 2 — gateway (:8080)
pnpm --filter @repo/gateway dev
# terminal 3 — frontend (:3000)
pnpm --filter @repo/web dev
```

Open http://localhost:3000 and run the sample query, or hit the gateway directly:

```bash
curl -s http://localhost:8080/query \
  -H 'content-type: application/json' \
  -d '{"intent":"fetch_user_profile","params":{"userId":"usr_99281a"}}' | jq
```

A second identical call returns `"meta": { "source": "cache" }`.

---

## Using it in a microservice

You don't need the gateway or the BFF to use the framework. Any Node service can
embed `data-core` and get the same cache → fixed-query → MCP-plan pipeline. See
**[docs/microservice-integration.md](docs/microservice-integration.md)** for the
full guide; the short version:

```ts
import {
  QueryEngine, RedisCache, AdapterRegistry,
  PostgresAdapter, MongoAdapter, StdioMcpPlanner,
} from "@repo/data-core";

const engine = new QueryEngine({
  cache: new RedisCache({ url: process.env.REDIS_URL }),
  adapters: new AdapterRegistry()
    .register(new PostgresAdapter({ connectionString: process.env.POSTGRES_URL! }))
    .register(new MongoAdapter({ url: process.env.MONGO_URL!, database: "app" })),
  // Share ONE MCP planning server across the fleet, or omit for in-process planning:
  planner: new StdioMcpPlanner({ command: "data-core-mcp", args: [] }),
});

const result = await engine.query({
  intent: "fetch_user_with_active_orders",
  params: { userId },
  options: { maxAgeMs: 5000 },
});

if (!result.ok) return reply.code(422).send(result);   // structured error, never a throw
return reply.send(result.data);
```

Each service keeps its own local Redis for a fast, isolated hot path, while a
shared MCP server gives the whole fleet one consistent source of query plans. Add
a new cross-store intent once, and every service can call it.

## License

MIT — see `packages/data-core/package.json`. The core framework is open source.
