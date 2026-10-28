import type { AdapterOp, DatabaseAdapter } from "./types.js";
import { err, ok, type Result } from "../result.js";

/**
 * MongoDB adapter (NoSQL side of the flexibility story).
 *
 * `mongodb` is an optional peer dependency, imported lazily for the same
 * reasons as the Postgres adapter.
 */

export interface MongoAdapterOptions {
  readonly url: string;
  readonly database: string;
  readonly name?: string;
}

interface MongoCollection {
  find(
    filter: Record<string, unknown>,
    opts?: { projection?: Record<string, 0 | 1>; limit?: number },
  ): { toArray(): Promise<unknown[]> };
  findOne(
    filter: Record<string, unknown>,
    opts?: { projection?: Record<string, 0 | 1> },
  ): Promise<unknown>;
}
interface MongoDb {
  collection(name: string): MongoCollection;
}
interface MongoClient {
  connect(): Promise<void>;
  db(name: string): MongoDb;
  close(): Promise<void>;
}

export class MongoAdapter implements DatabaseAdapter {
  readonly name: string;
  readonly kind = "nosql" as const;
  private client: MongoClient | undefined;
  private db: MongoDb | undefined;

  constructor(private readonly options: MongoAdapterOptions) {
    this.name = options.name ?? "mongo";
  }

  private async getDb(): Promise<Result<MongoDb>> {
    if (this.db) return ok(this.db);
    try {
      const mongo = (await import("mongodb")) as unknown as {
        MongoClient: new (url: string) => MongoClient;
      };
      this.client = new mongo.MongoClient(this.options.url);
      await this.client.connect();
      this.db = this.client.db(this.options.database);
      return ok(this.db);
    } catch (cause) {
      return err(
        "ADAPTER_ERROR",
        "The 'mongodb' driver is unavailable or failed to connect. Run: pnpm add mongodb",
        { details: { message: messageOf(cause) } },
      );
    }
  }

  async execute(op: AdapterOp): Promise<Result<unknown[]>> {
    if (op.kind !== "nosql") {
      return err(
        "ADAPTER_ERROR",
        `MongoAdapter received a '${op.kind}' op; expected 'nosql'.`,
      );
    }
    const db = await this.getDb();
    if (!db.ok) return db;
    try {
      const collection = db.data.collection(op.collection);
      if (op.operation === "findOne") {
        const projection = op.projection;
        const doc = await collection.findOne(
          op.filter,
          projection ? { projection } : undefined,
        );
        return ok(doc === null || doc === undefined ? [] : [doc]);
      }
      const findOpts: { projection?: Record<string, 0 | 1>; limit?: number } = {};
      if (op.projection) findOpts.projection = op.projection;
      if (op.limit !== undefined) findOpts.limit = op.limit;
      const docs = await collection.find(op.filter, findOpts).toArray();
      return ok(docs);
    } catch (cause) {
      return err("ADAPTER_ERROR", "Mongo query failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.db = undefined;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
