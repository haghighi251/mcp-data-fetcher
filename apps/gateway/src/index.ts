import express, { type Request, type Response } from "express";
import { QueryPayloadSchema } from "@repo/data-core";

/**
 * Express API gateway.
 *
 * The single public entry point for frontends. It does edge concerns only —
 * payload validation (reusing the SDK's Zod schema so the contract is shared),
 * light normalisation, and routing to the BFF. It holds no business logic and
 * no database access; the BFF + data-core own those.
 */

const app = express();
app.use(express.json({ limit: "256kb" }));

const BFF_URL = process.env["BFF_URL"] ?? "http://localhost:4000";
const PORT = Number(process.env["GATEWAY_PORT"] ?? 8080);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway" });
});

app.post("/query", async (req: Request, res: Response) => {
  // Validate at the edge so malformed payloads never reach the BFF.
  const parsed = QueryPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid Global Query payload",
        details: { issues: parsed.error.issues },
      },
      meta: {},
    });
    return;
  }

  try {
    const upstream = await fetch(`${BFF_URL}/data/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    const body = (await upstream.json()) as unknown;
    res.status(upstream.status).json(body);
  } catch (cause) {
    res.status(502).json({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "BFF is unreachable",
        details: { message: cause instanceof Error ? cause.message : String(cause) },
      },
      meta: {},
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[gateway] listening on :${PORT} → BFF ${BFF_URL}`);
});
