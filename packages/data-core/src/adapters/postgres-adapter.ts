import type { AdapterOp, DatabaseAdapter } from "./types.js";
import { err, ok, type Result } from "../result.js";

/**
 * PostgreSQL adapter (SQL side of the flexibility story).
 *
 * `pg` is an optional peer dependency. We import it lazily so installing
 * data-core without Postgres never breaks, and a missing driver surfaces as a
 * structured ADAPTER_ERROR instead of a module-resolution crash.
 */

export interface PostgresAdapterOptions {
  readonly connectionString: string;
  readonly name?: string;
  readonly max?: number;
}

// Minimal structural types so we don't hard-depend on `@types/pg` at build time.
interface PgQueryResult {
  rows: unknown[];
}
interface PgPool {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly name: string;
  readonly kind = "sql" as const;
  private pool: PgPool | undefined;

  constructor(private readonly options: PostgresAdapterOptions) {
    this.name = options.name ?? "postgres";
  }

  private async getPool(): Promise<Result<PgPool>> {
    if (this.pool) return ok(this.pool);
    try {
      const pg = (await import("pg")) as unknown as {
        default?: { Pool: new (cfg: unknown) => PgPool };
        Pool?: new (cfg: unknown) => PgPool;
      };
      const Pool = pg.Pool ?? pg.default?.Pool;
      if (!Pool) {
        return err("ADAPTER_ERROR", "pg module did not export Pool");
      }
      this.pool = new Pool({
        connectionString: this.options.connectionString,
        max: this.options.max ?? 10,
      });
      return ok(this.pool);
    } catch {
      return err(
        "ADAPTER_ERROR",
        "The 'pg' driver is not installed. Run: pnpm add pg",
      );
    }
  }

  async execute(op: AdapterOp): Promise<Result<unknown[]>> {
    if (op.kind !== "sql") {
      return err(
        "ADAPTER_ERROR",
        `PostgresAdapter received a '${op.kind}' op; expected 'sql'.`,
      );
    }
    const pool = await this.getPool();
    if (!pool.ok) return pool;
    try {
      const res = await pool.data.query(op.text, op.values);
      return ok(res.rows);
    } catch (cause) {
      return err("ADAPTER_ERROR", "Postgres query failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
