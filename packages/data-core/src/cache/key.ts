import { createHash } from "node:crypto";
import type { QueryPayload } from "../schema.js";

/**
 * Deterministic cache key generation.
 *
 * The key is derived from `intent` + a canonical form of `params` only.
 * `options` (maxAgeMs / forceRefresh) are intentionally excluded: they control
 * freshness and read behaviour, not identity, so two requests for the same data
 * with different options share a cache slot.
 *
 * Canonicalisation recursively sorts object keys so that `{a:1,b:2}` and
 * `{b:2,a:1}` hash identically — the "order-insensitive params" guarantee.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

export function cacheKey(payload: QueryPayload, prefix = "dcore"): string {
  const canonical = JSON.stringify({
    intent: payload.intent,
    params: canonicalize(payload.params),
  });
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `${prefix}:${payload.intent}:${digest}`;
}
