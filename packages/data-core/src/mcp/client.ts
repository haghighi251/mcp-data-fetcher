import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExecutionPlan } from "../plan.js";
import type { QueryPayload } from "../schema.js";
import { err, ok, type Result } from "../result.js";
import { planQuery, type PlanOutcome } from "./planner.js";

/**
 * The engine talks to the planner through this interface. Two implementations:
 *
 *   - InProcessPlanner : calls the planner directly. Zero IPC overhead; ideal
 *                        for local dev, tests, and single-process deployments.
 *   - StdioMcpPlanner  : connects to a separate MCP server process over stdio
 *                        using the real MCP SDK. This is the "customer-hosted
 *                        MCP server" topology from the architecture.
 *
 * Both return a structured Result so the engine never has to catch.
 */
export interface Planner {
  plan(payload: QueryPayload): Promise<Result<ExecutionPlan>>;
  close?(): Promise<void>;
}

export class InProcessPlanner implements Planner {
  async plan(payload: QueryPayload): Promise<Result<ExecutionPlan>> {
    return toResult(planQuery(payload));
  }
}

export interface StdioMcpPlannerOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class StdioMcpPlanner implements Planner {
  private client: Client | undefined;

  constructor(private readonly options: StdioMcpPlannerOptions) {}

  private async getClient(): Promise<Result<Client>> {
    if (this.client) return ok(this.client);
    try {
      const transport = new StdioClientTransport({
        command: this.options.command,
        args: [...this.options.args],
      });
      const client = new Client(
        { name: "data-core-engine", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      return ok(client);
    } catch (cause) {
      return err("MCP_UNAVAILABLE", "Could not start/connect MCP planner", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async plan(payload: QueryPayload): Promise<Result<ExecutionPlan>> {
    const client = await this.getClient();
    if (!client.ok) return client;
    try {
      const res = await client.data.callTool({
        name: "plan_query",
        arguments: payload,
      });
      const text = extractText(res);
      if (text === null) {
        return err("PLAN_ERROR", "MCP planner returned no text content");
      }
      return toResult(JSON.parse(text) as PlanOutcome);
    } catch (cause) {
      return err("PLAN_ERROR", "MCP plan_query call failed", {
        details: { message: messageOf(cause) },
      });
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

function toResult(outcome: PlanOutcome): Result<ExecutionPlan> {
  if (outcome.ok && outcome.plan) return ok(outcome.plan);
  return err("PLAN_ERROR", outcome.error ?? "Planner produced no plan");
}

interface ToolTextResult {
  content?: Array<{ type: string; text?: string }>;
}
function extractText(res: unknown): string | null {
  const content = (res as ToolTextResult).content;
  if (!Array.isArray(content)) return null;
  const first = content.find((c) => c.type === "text" && typeof c.text === "string");
  return first?.text ?? null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
