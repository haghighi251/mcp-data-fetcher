import type { AdapterOp } from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/types.js";
import { type ExecutionPlan, REF_PREFIX } from "../plan.js";
import { err, ok, type Result } from "../result.js";

/**
 * Executes a compiled plan against the adapter registry.
 *
 * Steps run in dependency waves: every step whose dependencies are satisfied
 * runs concurrently (Promise.all), then the next wave. `$ref:` tokens in a
 * step's op are resolved from already-completed step outputs before the op runs.
 */

type StepOutputs = Map<string, unknown[]>;

export async function executePlan(
  plan: ExecutionPlan,
  adapters: AdapterRegistry,
): Promise<Result<Record<string, unknown>>> {
  const outputs: StepOutputs = new Map();
  const remaining = new Set(plan.steps.map((s) => s.id));
  const byId = new Map(plan.steps.map((s) => [s.id, s]));

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const step = byId.get(id);
      return (step?.dependsOn ?? []).every((dep) => outputs.has(dep));
    });

    if (ready.length === 0) {
      return err("PLAN_EXECUTION_ERROR", "Plan has a cyclic or unsatisfiable dependency", {
        details: { remaining: [...remaining] },
      });
    }

    const wave = await Promise.all(
      ready.map(async (id): Promise<Result<{ id: string; rows: unknown[] }>> => {
        const step = byId.get(id)!;
        const adapter = adapters.get(step.adapter);
        if (!adapter) {
          return err("ADAPTER_NOT_FOUND", `No adapter named '${step.adapter}'`, {
            details: { step: id },
          });
        }
        const resolvedOp = resolveRefs(step.op, outputs);
        if (!resolvedOp.ok) return resolvedOp;
        const rowsResult = await adapter.execute(resolvedOp.data);
        if (!rowsResult.ok) return rowsResult;
        return ok({ id, rows: rowsResult.data });
      }),
    );

    for (const stepResult of wave) {
      if (!stepResult.ok) return stepResult;
      outputs.set(stepResult.data.id, stepResult.data.rows);
      remaining.delete(stepResult.data.id);
    }
  }

  // Assemble the final shape. A field maps to a step's rows; single-row steps
  // (findOne / LIMIT 1) are unwrapped to the row itself for ergonomics.
  const assembled: Record<string, unknown> = {};
  for (const [field, stepId] of Object.entries(plan.shape)) {
    const rows = outputs.get(stepId) ?? [];
    assembled[field] = rows.length === 1 ? rows[0] : rows;
  }
  return ok(assembled);
}

/** Replace "$ref:stepId.path" tokens anywhere inside an op. */
function resolveRefs(op: AdapterOp, outputs: StepOutputs): Result<AdapterOp> {
  let failure: string | null = null;

  const walk = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith(REF_PREFIX)) {
      const resolved = resolveRef(value.slice(REF_PREFIX.length), outputs);
      if (resolved === undefined) failure = value;
      return resolved;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  const resolvedOp = walk(op) as AdapterOp;
  if (failure !== null) {
    return err("PLAN_EXECUTION_ERROR", `Unresolvable $ref token: ${failure}`);
  }
  return ok(resolvedOp);
}

function resolveRef(ref: string, outputs: StepOutputs): unknown {
  const [stepId, ...path] = ref.split(".");
  const rows = outputs.get(stepId ?? "");
  if (!rows || rows.length === 0) return undefined;
  let current: unknown = rows[0];
  for (const segment of path) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
