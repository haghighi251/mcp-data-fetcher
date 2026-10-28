# Using the framework in a microservice

`@repo/data-core` is a library, not a service. The gateway and NestJS BFF in this
repo are *one* way to consume it; any Node service can embed the engine directly
and get the same cache → fixed-query → MCP-plan pipeline. This guide shows the
patterns.

## 1. Install

```bash
pnpm add @repo/data-core ioredis
# install only the drivers you actually use (optional peer deps):
pnpm add pg          # for PostgresAdapter
pnpm add mongodb     # for MongoAdapter
```

## 2. Assemble one engine per process

Build the engine once at startup and reuse it (it holds the Redis connection and
adapter pools). Register only the adapters your service needs.

```ts
// data.ts
import {
  QueryEngine, RedisCache, AdapterRegistry,
  PostgresAdapter, MongoAdapter, FixedQueryRegistry,
  InProcessPlanner, StdioMcpPlanner, type Planner,
} from "@repo/data-core";

function resolvePlanner(): Planner {
  if (process.env.MCP_TRANSPORT === "stdio") {
    return new StdioMcpPlanner({
      command: process.env.MCP_SERVER_COMMAND ?? "data-core-mcp",
      args: (process.env.MCP_SERVER_ARGS ?? "").split(" ").filter(Boolean),
    });
  }
  return new InProcessPlanner();
}

export const engine = new QueryEngine({
  cache: new RedisCache({ url: process.env.REDIS_URL, defaultTtlMs: 5000 }),
  adapters: new AdapterRegistry()
    .register(new PostgresAdapter({ connectionString: process.env.POSTGRES_URL! }))
    .register(new MongoAdapter({ url: process.env.MONGO_URL!, database: "app" })),
  fixedQueries: new FixedQueryRegistry().register("fetch_user_profile", (p) => ({
    intent: p.intent,
    steps: [{
      id: "user",
      adapter: "postgres",
      op: { kind: "sql", text: "SELECT id,email,name FROM users WHERE id=$1 LIMIT 1",
            values: [String(p.params.userId)] },
    }],
    shape: { user: "user" },
    ttlMs: 10_000,
  })),
  planner: resolvePlanner(),
  cachePrefix: "orders-svc",   // namespace this service's cache entries
});
```

> **Cache namespacing:** give each service its own `cachePrefix` so independent
> services don't collide on keys, even for the same intent. If you *want* services
> to share a cache, give them the same prefix and the same Redis.

## 3. Call it from your transport layer

The engine is transport-agnostic. Because it returns a `Result<T>` and never
throws, mapping to HTTP (or gRPC, or a queue consumer) is mechanical.

### Fastify / Express

```ts
app.post("/users/:id/overview", async (req, reply) => {
  const result = await engine.query({
    intent: "fetch_user_with_active_orders",
    params: { userId: req.params.id },
    options: { maxAgeMs: 5000 },
  });

  if (!result.ok) {
    const status = result.error.code === "VALIDATION_ERROR" ? 400
                 : result.error.code === "INTENT_NOT_FOUND" ? 404
                 : 422;
    return reply.code(status).send(result);
  }
  // result.meta.source tells you cache | fixed-query | mcp-plan
  return reply.send(result.data);
});
```

### Invalidate after a mutation

```ts
await writeOrder(order);
await engine.invalidate({
  intent: "fetch_user_with_active_orders",
  params: { userId: order.userId },
});
```

## 4. Topology choices for a fleet

```text
                      ┌───────────────────────────────┐
  users-svc  ───────▶ │  one shared MCP planning server │   (stdio, holds no data)
  orders-svc ───────▶ │       data-core-mcp (Node.js)   │
  billing-svc ──────▶ └───────────────────────────────┘
       │ each service keeps its OWN local Redis + adapters (fast, isolated hot path)
       ▼
   Redis  +  Postgres / Mongo
```

- **In-process planner** (`MCP_TRANSPORT=inprocess`): simplest; the planner runs
  inside each service. Good default; zero extra moving parts.
- **Shared MCP server** (`MCP_TRANSPORT=stdio`): run `data-core-mcp` once and point
  every service at it so the whole fleet compiles plans from one source of truth.
  Define a new cross-store intent in the planner once; every service can use it
  immediately without a redeploy of its query logic.

Either way, **caching and execution stay local to each service** — only *plans*
(never rows) are centralized, so no data crosses a service boundary through the
planner.

## 5. Graceful shutdown

```ts
process.on("SIGTERM", async () => {
  await engine.close();   // closes Redis, adapter pools, and the MCP client
  process.exit(0);
});
```

## 6. Register a new intent

1. **Fixed (hot, reviewed) path:** add a builder to the `FixedQueryRegistry`. Full
   control over SQL/NoSQL ops; no planning latency.
2. **Dynamic path:** add the intent to `describeIntents()` and a branch in
   `planQuery` (`packages/data-core/src/mcp/planner.ts`). Every service using the
   shared MCP server picks it up.

In both cases the caller contract is unchanged — it still sends the same Global
Query payload. That's the point: the *how* moves, the *what* stays stable.
