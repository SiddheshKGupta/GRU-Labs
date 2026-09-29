// `gru workbench`: serves the Workbench page and the ledger view on loopback.
//
// Read-only by construction: GET / and GET /api/state, nothing else, so
// the page cannot approve, revoke or run anything; decisions stay in the
// Director channel. Bound to 127.0.0.1, and requests whose Host header is
// not this loopback address are refused, so a web page elsewhere cannot
// read the ledger through DNS rebinding.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkbenchView } from "./model.ts";
import { workbenchHtml } from "./page.ts";

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface WorkbenchServer {
  readonly url: string;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
  });
  response.end(body);
}

export async function startWorkbench(options: { view: () => WorkbenchView; port?: number; pollMs?: number }): Promise<WorkbenchServer> {
  const page = workbenchHtml({ mode: "live", ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }) });
  let allowedHosts = new Set<string>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!allowedHosts.has(request.headers.host ?? "")) return send(response, 403, "text/plain; charset=utf-8", "forbidden host\n");
    if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "read-only\n");
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/") return send(response, 200, "text/html; charset=utf-8", page);
    if (path === "/api/state") {
      try {
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(options.view()));
      } catch (error) {
        return send(response, 500, "text/plain; charset=utf-8", `cannot read the ledger: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return send(response, 404, "text/plain; charset=utf-8", "not found\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7420, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 7420;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
