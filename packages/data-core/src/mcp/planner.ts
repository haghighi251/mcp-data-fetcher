import type { ExecutionPlan } from "../plan.js";
import type { QueryPayload } from "../schema.js";

/**
 * The planning brain that lives inside the MCP server.
 *
 * In a real deployment this is where a customer plugs in their schema-aware
 * planning logic (or an LLM-assisted planner). Here it is a deterministic
 * rules-based planner: it maps a known intent to a concrete execution graph
 * across SQL and NoSQL adapters. This keeps the data path predictable while
 * still demonstrating dynamic, cross-store plan compilation.
 *
 * Intents the planner understands are advertised via `describeIntents()` so the
 * MCP `list_intents` tool can surface them to clients/agents.
 */

export interface IntentDescriptor {
  readonly intent: string;
  readonly description: string;
  readonly requiredParams: ReadonlyArray<string>;
}

const INTENTS: ReadonlyArray<IntentDescriptor> = [
  {
    intent: "fetch_user_with_active_orders",
    description:
      "Load a user from Postgres and their active orders from MongoDB, joined on userId.",
    requiredParams: ["userId"],
  },
  {
    intent: "fetch_user_profile",
    description: "Load a single user profile row from Postgres.",
    requiredParams: ["userId"],
  },
];

export function describeIntents(): ReadonlyArray<IntentDescriptor> {
  return INTENTS;
}

export interface PlanOutcome {
  readonly ok: boolean;
  readonly plan?: ExecutionPlan;
  readonly error?: string;
}

/**
 * Compile a payload into an execution plan. Returns a plain outcome object
 * (not a Result<>) so it serialises cleanly over the MCP tool boundary.
 */
export function planQuery(payload: QueryPayload): PlanOutcome {
  const descriptor = INTENTS.find((i) => i.intent === payload.intent);
  if (!descriptor) {
    return { ok: false, error: `No plan registered for intent '${payload.intent}'.` };
  }
  const missing = descriptor.requiredParams.filter(
    (p) => payload.params[p] === undefined,
  );
  if (missing.length > 0) {
    return { ok: false, error: `Missing required params: ${missing.join(", ")}` };
  }

  const userId = String(payload.params["userId"]);

  if (payload.intent === "fetch_user_profile") {
    return {
      ok: true,
      plan: {
        intent: payload.intent,
        steps: [
          {
            id: "user",
            adapter: "postgres",
            op: {
              kind: "sql",
              text: "SELECT id, email, name FROM users WHERE id = $1 LIMIT 1",
              values: [userId],
            },
          },
        ],
        shape: { user: "user" },
        ttlMs: 10_000,
      },
    };
  }

  // fetch_user_with_active_orders: Postgres user + Mongo active orders.
  return {
    ok: true,
    plan: {
      intent: payload.intent,
      steps: [
        {
          id: "user",
          adapter: "postgres",
          op: {
            kind: "sql",
            text: "SELECT id, email, name FROM users WHERE id = $1 LIMIT 1",
            values: [userId],
          },
        },
        {
          id: "orders",
          adapter: "mongo",
          op: {
            kind: "nosql",
            collection: "orders",
            operation: "find",
            filter: { userId, status: "active" },
            limit: 50,
          },
        },
      ],
      shape: { user: "user", activeOrders: "orders" },
      ttlMs: 5_000,
    },
  };
}
