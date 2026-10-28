"use client";

import { type ReactElement, useState } from "react";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

const SAMPLE = JSON.stringify(
  {
    intent: "fetch_user_with_active_orders",
    params: { userId: "usr_99281a" },
    options: { maxAgeMs: 5000, forceRefresh: false },
  },
  null,
  2,
);

export function QueryConsole(): ReactElement {
  const [input, setInput] = useState(SAMPLE);
  const [output, setOutput] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function run(): Promise<void> {
    setLoading(true);
    setOutput("");
    try {
      const payload: unknown = JSON.parse(input);
      const res = await fetch(`${GATEWAY_URL}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json();
      setOutput(JSON.stringify(body, null, 2));
    } catch (error) {
      setOutput(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: "CLIENT_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Global Query payload
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="h-64 w-full rounded-lg border border-neutral-300 bg-white p-3 font-mono text-sm shadow-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => void run()}
          disabled={loading}
          className="inline-flex w-fit items-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {loading ? "Running…" : "Run query"}
        </button>
      </section>
      <section className="flex flex-col gap-2">
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Result
        </label>
        <pre className="h-64 w-full overflow-auto rounded-lg border border-neutral-300 bg-white p-3 font-mono text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          {output || "// result will appear here"}
        </pre>
      </section>
    </div>
  );
}
