import type { AdapterOp } from "./adapters/types.js";

/**
 * A compiled execution graph. Produced either by a registered fixed query or by
 * the MCP planner, then run by the engine's executor. Steps execute in
 * dependency order; independent steps run concurrently.
 *
 * A step's op may reference an earlier step's output with a `$ref` token:
 *   "$ref:step_id.path.to.value"  (path is resolved against the first row)
 * This is how a plan threads, e.g., a userId from step 1 into step 2's filter.
 */

export interface PlanStep {
  readonly id: string;
  /** Name of the adapter in the registry this step runs against. */
  readonly adapter: string;
  /** Op template; may contain "$ref:<stepId>.<path>" string tokens. */
  readonly op: AdapterOp;
  /** Step ids that must complete before this one. */
  readonly dependsOn?: ReadonlyArray<string>;
}

export interface ExecutionPlan {
  readonly intent: string;
  readonly steps: ReadonlyArray<PlanStep>;
  /**
   * How to assemble the final payload from step outputs. Each key maps to a
   * step id whose rows become that field's value.
   */
  readonly shape: Record<string, string>;
  /** TTL hint (ms) the planner recommends for caching this intent's result. */
  readonly ttlMs?: number;
}

export const REF_PREFIX = "$ref:";
