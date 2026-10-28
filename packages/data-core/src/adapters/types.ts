import type { Result } from "../result.js";

/**
 * Database adapters are the pluggable edge of the engine. The query engine and
 * the MCP planner only ever speak in terms of `AdapterOp`s; each adapter knows
 * how to turn its op dialect into a real driver call. This is what lets one
 * intent fan out across SQL and NoSQL stores concurrently.
 */

/** A relational operation, expressed as a parameterised statement. */
export interface SqlOp {
  readonly kind: "sql";
  /** Parameterised SQL. Never interpolate values into `text`. */
  readonly text: string;
  readonly values?: ReadonlyArray<unknown>;
}

/** A document-store operation. */
export interface NoSqlOp {
  readonly kind: "nosql";
  readonly collection: string;
  readonly operation: "find" | "findOne";
  readonly filter: Record<string, unknown>;
  readonly projection?: Record<string, 0 | 1>;
  readonly limit?: number;
}

export type AdapterOp = SqlOp | NoSqlOp;

export interface DatabaseAdapter {
  /** Unique name used by plans/fixed queries to address this adapter. */
  readonly name: string;
  readonly kind: AdapterOp["kind"];
  /** Execute an op, returning rows/documents as a structured result. */
  execute(op: AdapterOp): Promise<Result<unknown[]>>;
  /** Optional graceful shutdown (close pools/clients). */
  close?(): Promise<void>;
}

/** Simple name-addressed registry of adapters available to an engine. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, DatabaseAdapter>();

  register(adapter: DatabaseAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  get(name: string): DatabaseAdapter | undefined {
    return this.adapters.get(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): DatabaseAdapter[] {
    return [...this.adapters.values()];
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.close?.()));
  }
}
