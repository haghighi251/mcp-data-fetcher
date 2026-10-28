import { z } from "zod";

/**
 * Global Query Syntax — the single JSON shape every service uses to describe a
 * data requirement. Validated with Zod at the edge of the SDK so no invalid
 * payload ever reaches the cache, the planner or an adapter.
 */

export const QueryOptionsSchema = z
  .object({
    /** Reject cache entries older than this many ms. Also seeds the write TTL. */
    maxAgeMs: z.number().int().positive().max(86_400_000).optional(),
    /** Skip the cache read (still writes the fresh value back). */
    forceRefresh: z.boolean().optional(),
  })
  .strict();

export const QueryPayloadSchema = z
  .object({
    /** Stable, registry-addressable name of the data requirement. */
    intent: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, "intent must be snake_case"),
    /** Intent parameters. Order-insensitive for cache-key purposes. */
    params: z.record(z.string(), z.unknown()).default({}),
    options: QueryOptionsSchema.default({}),
  })
  .strict();

export type QueryOptions = z.infer<typeof QueryOptionsSchema>;
export type QueryPayload = z.infer<typeof QueryPayloadSchema>;

/** Parse-and-narrow; callers convert ZodError into a VALIDATION_ERROR result. */
export function parseQueryPayload(input: unknown): QueryPayload {
  return QueryPayloadSchema.parse(input);
}
