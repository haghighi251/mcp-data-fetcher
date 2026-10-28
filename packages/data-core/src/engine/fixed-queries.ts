import type { ExecutionPlan } from "../plan.js";
import type { QueryPayload } from "../schema.js";

/**
 * Fixed-query overrides.
 *
 * A fixed query is a developer-registered, hand-compiled execution plan for an
 * intent. When one exists it bypasses the MCP planner entirely — this is the
 * "bulletproof production performance" path: deterministic, reviewed, no
 * planning latency. Dynamic intents fall through to the MCP planner.
 */

export type FixedQueryBuilder = (payload: QueryPayload) => ExecutionPlan;

export class FixedQueryRegistry {
  private readonly builders = new Map<string, FixedQueryBuilder>();

  register(intent: string, builder: FixedQueryBuilder): this {
    this.builders.set(intent, builder);
    return this;
  }

  has(intent: string): boolean {
    return this.builders.has(intent);
  }

  build(payload: QueryPayload): ExecutionPlan | undefined {
    return this.builders.get(payload.intent)?.(payload);
  }
}
