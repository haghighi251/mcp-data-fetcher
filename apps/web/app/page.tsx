import type { ReactElement } from "react";
import { QueryConsole } from "./query-console";

export default function Home(): ReactElement {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">MCP Data Fetcher</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Issue a Global Query payload. It travels through the Express gateway to
          the NestJS BFF, which resolves it via the data-core engine
          (Redis hot-path → fixed query / MCP plan → SQL&nbsp;+&nbsp;NoSQL).
        </p>
      </header>
      <QueryConsole />
    </main>
  );
}
