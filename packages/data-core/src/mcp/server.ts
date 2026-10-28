#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QueryPayloadSchema } from "../schema.js";
import { describeIntents, planQuery } from "./planner.js";

/**
 * Customer-hosted MCP query-planning server (Node.js).
 *
 * Exposes two tools over stdio:
 *   - list_intents : advertise the intents this planner can compile
 *   - plan_query   : compile a Global Query payload into an execution graph
 *
 * It holds no data and no DB connections — it only produces plans. The engine
 * (RedisCache + adapters) does the actual fetching, so no data leaves the
 * customer's infrastructure through this server.
 *
 * Run standalone:  node dist/mcp/server.js   (or `data-core-mcp`)
 */

export function createMcpServer(): Server {
  const server = new Server(
    { name: "data-core-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_intents",
        description:
          "List the query intents this planner can compile, with their required params.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "plan_query",
        description:
          "Compile a Global Query Syntax payload into a concrete cross-store execution plan.",
        inputSchema: {
          type: "object",
          properties: {
            intent: { type: "string" },
            params: { type: "object" },
            options: { type: "object" },
          },
          required: ["intent"],
          additionalProperties: true,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "list_intents") {
      return jsonContent({ intents: describeIntents() });
    }

    if (name === "plan_query") {
      const parsed = QueryPayloadSchema.safeParse(args);
      if (!parsed.success) {
        return jsonContent(
          { ok: false, error: `Invalid payload: ${parsed.error.message}` },
          true,
        );
      }
      const outcome = planQuery(parsed.data);
      return jsonContent(outcome, !outcome.ok);
    }

    return jsonContent({ ok: false, error: `Unknown tool '${name}'.` }, true);
  });

  return server;
}

function jsonContent(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError,
  };
}

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("[data-core-mcp] ready on stdio");
}

// Run only when executed directly (not when imported for in-process use).
// pathToFileURL handles Windows drive letters (file:///C:/...) correctly.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[data-core-mcp] fatal", error);
    process.exit(1);
  });
}
