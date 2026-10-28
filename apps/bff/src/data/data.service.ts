import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Logger,
} from "@nestjs/common";
import {
  AdapterRegistry,
  FixedQueryRegistry,
  InProcessPlanner,
  MongoAdapter,
  PostgresAdapter,
  QueryEngine,
  RedisCache,
  StdioMcpPlanner,
  type Planner,
  type Result,
} from "@repo/data-core";

/**
 * Owns a single QueryEngine for the lifetime of the BFF process. This is the
 * one place the framework is assembled: cache + adapters + fixed queries +
 * planner. Controllers just call `run()`.
 */
@Injectable()
export class DataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataService.name);
  private engine!: QueryEngine;

  onModuleInit(): void {
    const cache = new RedisCache({
      url: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      defaultTtlMs: Number(process.env["CACHE_DEFAULT_TTL_MS"] ?? 5000),
    });

    // Register only the adapters whose connection strings are configured.
    const adapters = new AdapterRegistry();
    const pg = process.env["POSTGRES_URL"];
    if (pg) {
      adapters.register(new PostgresAdapter({ connectionString: pg, name: "postgres" }));
      this.logger.log("Registered Postgres adapter");
    }
    const mongoUrl = process.env["MONGO_URL"];
    if (mongoUrl) {
      adapters.register(
        new MongoAdapter({
          url: mongoUrl,
          database: process.env["MONGO_DB"] ?? "app",
          name: "mongo",
        }),
      );
      this.logger.log("Registered Mongo adapter");
    }

    // Example fixed-query override: a hand-compiled, deterministic plan.
    const fixedQueries = new FixedQueryRegistry().register(
      "fetch_user_profile",
      (payload) => ({
        intent: payload.intent,
        steps: [
          {
            id: "user",
            adapter: "postgres",
            op: {
              kind: "sql",
              text: "SELECT id, email, name FROM users WHERE id = $1 LIMIT 1",
              values: [String(payload.params["userId"])],
            },
          },
        ],
        shape: { user: "user" },
        ttlMs: 10_000,
      }),
    );

    this.engine = new QueryEngine({
      cache,
      adapters,
      fixedQueries,
      planner: this.resolvePlanner(),
      cachePrefix: process.env["CACHE_PREFIX"] ?? "dcore",
    });

    this.logger.log(`QueryEngine ready (planner=${process.env["MCP_TRANSPORT"] ?? "inprocess"})`);
  }

  private resolvePlanner(): Planner {
    if ((process.env["MCP_TRANSPORT"] ?? "inprocess") === "stdio") {
      const command = process.env["MCP_SERVER_COMMAND"] ?? "node";
      const args = (process.env["MCP_SERVER_ARGS"] ?? "")
        .split(" ")
        .filter((a) => a.length > 0);
      return new StdioMcpPlanner({ command, args });
    }
    return new InProcessPlanner();
  }

  run(payload: unknown): Promise<Result<Record<string, unknown>>> {
    return this.engine.query(payload);
  }

  invalidate(payload: unknown): Promise<Result<void>> {
    return this.engine.invalidate(payload);
  }

  async onModuleDestroy(): Promise<void> {
    await this.engine?.close();
  }
}
