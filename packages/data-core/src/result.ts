/**
 * Structured result object used across the whole data-fetching pipeline.
 *
 * Per the project guardrails we never throw unhandled errors down the pipeline;
 * every layer (cache, adapters, planner, engine) returns a discriminated
 * `Result<T>` with a stable error `code` the callers can branch on.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "CACHE_ERROR"
  | "ADAPTER_ERROR"
  | "ADAPTER_NOT_FOUND"
  | "INTENT_NOT_FOUND"
  | "PLAN_ERROR"
  | "PLAN_EXECUTION_ERROR"
  | "MCP_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ResultMeta {
  /** Which path produced the data, useful for telemetry and debugging. */
  readonly source?: "cache" | "fixed-query" | "mcp-plan";
  /** Deterministic cache key the request resolved to. */
  readonly cacheKey?: string;
  /** Wall-clock duration of the resolve, in milliseconds. */
  readonly durationMs?: number;
}

export interface Ok<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: ResultMeta;
}

export interface Err {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    /** Non-sensitive extra context (never DB rows or secrets). */
    readonly details?: Record<string, unknown>;
  };
  readonly meta: ResultMeta;
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T, meta: ResultMeta = {}): Ok<T> {
  return { ok: true, data, meta };
}

export function err(
  code: ErrorCode,
  message: string,
  options: { details?: Record<string, unknown>; meta?: ResultMeta } = {},
): Err {
  const error: Err["error"] =
    options.details === undefined
      ? { code, message }
      : { code, message, details: options.details };
  return { ok: false, error, meta: options.meta ?? {} };
}

/** Narrowing helper. */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

/** Attach/merge metadata onto an existing result without mutating it. */
export function withMeta<T>(result: Result<T>, meta: ResultMeta): Result<T> {
  return { ...result, meta: { ...result.meta, ...meta } } as Result<T>;
}
