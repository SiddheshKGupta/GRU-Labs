// A scripted OpenAI-compatible endpoint on 127.0.0.1 for the route tests.
//
// It listens on an ephemeral port on the loopback interface only, records
// every request it receives (method, path, headers, parsed JSON body) and
// answers from a handler the test supplies. Nothing leaves the machine.

import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockReply {
  status?: number;
  /** Serialised as JSON unless `raw` is given. */
  body?: unknown;
  raw?: string;
  /** Hold the reply this long before answering (for timeout tests). */
  delay_ms?: number;
}

export interface MockServer {
  /** http://127.0.0.1:<port> -- no path. */
  origin: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

export type MockHandler = (request: MockRequest, index: number) => MockReply | Promise<MockReply>;

function send(response: ServerResponse, reply: MockReply): void {
  const status = reply.status ?? 200;
  const text = reply.raw ?? JSON.stringify(reply.body ?? {});
  response.writeHead(status, { "content-type": reply.raw === undefined ? "application/json" : "text/plain" });
  response.end(text);
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const request: MockRequest = {
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body,
      };
      const index = requests.length;
      requests.push(request);
      void (async () => {
        const reply = await handler(request, index);
        if (reply.delay_ms !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delay_ms));
        if (!response.destroyed) send(response, reply);
      })().catch(() => {
        if (!response.destroyed) send(response, { status: 500, body: { error: { message: "mock handler threw" } } });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
