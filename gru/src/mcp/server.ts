// MCP server exposing a GovernedSession to Claude Code or Codex.
//
// Why: a host that calls the gru_* tools gets GRU's gate path (parse ->
// classify -> authorize -> escalate -> execute -> evidence) instead of its
// own built-in tools, and gru_verify_and_close runs the Project Director's
// verification contract rather than trusting the model's word. Hooks run
// as one process per event while a session lives in memory, so this
// long-lived process also hosts the hook daemon, and both share one
// lazily opened session.
//
// The Director channel over MCP is elicitation: AVL's escalation becomes an
// elicitation/create request the host shows the user. The director exists
// before the session does and is handed to `openSession`, because the
// kernel needs it at open time.
//
// Honest limits: this server governs only what the host routes through it.
// Host built-in tools are mediated only by hooks (Claude Code) or not at
// all (Codex; see hooks/host-map.ts). A client that does not declare
// elicitation cannot ask the user, so every escalation fails closed. When
// the host closes stdin the episode is closed with outcome HOST_ENDED.

import type { Readable, Writable } from "node:stream";
import { toolDefinitions, type ToolDefinition } from "../avl/actions.ts";
import { AVL } from "../avl/principal.ts";
import { startHookDaemon, type HookDaemon } from "../hooks/daemon.ts";
import type { HostMapContext } from "../hooks/host-map.ts";
import type { DirectorChannel, DirectorDecision, EpisodeReport, EscalationRequest, GovernedSession } from "../types.ts";
import { INVALID_PARAMS, JsonRpcPeer, RpcError, type JsonRpcId, type RequestHandler } from "./jsonrpc.ts";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = Object.freeze({ name: "gru", version: "0.1.0" });
export const TOOL_PREFIX = "gru_";
export const STATUS_TOOL = "gru_status";
export const CLOSE_TOOL = "gru_verify_and_close";
export const ELICITATION_TIMEOUT_MS = 5 * 60_000;
export const DIRECTOR_ACTOR = "director:mcp-elicitation";
export const NO_CHANNEL_REASON = "no Director channel: this MCP client cannot ask the user; escalations fail closed";

export const INSTRUCTIONS =
  "These tools are governed by GRU's AVL (Authority & Verification Layer). Every call is authorized " +
  "before it runs and recorded in a hash-chained episode ledger. Changing protected verification files " +
  "needs Project Director approval. When the task is done, call gru_verify_and_close: it runs the " +
  "Director's verification contract and returns the truthful closure; saying the work is done does not verify it.";

const GOVERNED_NOTE = " Governed by GRU: AVL authorizes this call and records it in the episode ledger.";
const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface McpServerOptions {
  /** Called once, lazily, at the first tools/call or hook event. Receives the server's Director channel. */
  openSession: (channel: { director: DirectorChannel }) => Promise<GovernedSession>;
  /** Declared command ids, so tools/list works before the session opens. */
  commandIds: readonly string[];
  input: Readable;
  output: Writable;
  /** When set, the hook daemon listens here (see hooks/daemon.ts socketPathFor). */
  socketPath?: string;
  /** Required with socketPath: how host tool calls are mapped to effects. */
  hostContext?: HostMapContext;
  log?: (line: string) => void;
  elicitationTimeoutMs?: number;
}

/** What the Director channel needs from a server; a seam for tests. */
export interface ElicitationPeer {
  readonly clientSupportsElicitation: boolean;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function escalationMessage(request: EscalationRequest): string {
  return [
    "GRU AVL needs a Project Director decision before this action can run.",
    `Tool: ${request.tool} (proposed by ${request.principal})`,
    `Effect: ${JSON.stringify(request.effect)}`,
    `Consequences: ${request.consequences.join(", ") || "none"}`,
    `Why: ${request.reasons.join("; ") || "no reason given"}`,
    ...(request.preview === undefined ? [] : ["What would happen (the Minion wrote this content):", request.preview]),
    `Authorization ${request.authorization_id}, proposal ${request.proposal_id}. Approving covers this one action only.`,
  ].join("\n");
}

export const ELICITATION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    approve: { type: "boolean", title: "Approve this action?" },
    reason: { type: "string", title: "Reason" },
  },
  required: ["approve"],
});

function reject(actor: string, reason: string): DirectorDecision {
  return { decision: "REJECT", actor, reason };
}

/** Maps an elicitation result to a decision. Only an explicit approve: true approves. */
export function decisionFromElicitation(result: unknown): DirectorDecision {
  if (!isRecord(result)) return reject(AVL.id, "malformed elicitation result; escalation fails closed");
  const given = isRecord(result.content) && typeof result.content.reason === "string" && result.content.reason.trim() !== ""
    ? result.content.reason
    : null;
  switch (result.action) {
    case "accept":
      if (isRecord(result.content) && result.content.approve === true) {
        return { decision: "APPROVE", actor: DIRECTOR_ACTOR, reason: given ?? "approved by the Project Director via MCP elicitation" };
      }
      if (isRecord(result.content) && result.content.approve === false) {
        return reject(DIRECTOR_ACTOR, given ?? "the Project Director did not approve");
      }
      return reject(AVL.id, "elicitation accepted without an approve answer; escalation fails closed");
    case "decline":
      return reject(DIRECTOR_ACTOR, "the Project Director declined via MCP elicitation");
    case "cancel":
      // Dismissed without deciding: no Director decision exists, so AVL fails closed.
      return reject(AVL.id, "the elicitation was dismissed without a decision; escalation fails closed");
    default:
      return reject(AVL.id, "unrecognised elicitation action; escalation fails closed");
  }
}

export function elicitationDirector(server: ElicitationPeer, timeoutMs: number = ELICITATION_TIMEOUT_MS): DirectorChannel {
  return {
    async decide(request: EscalationRequest): Promise<DirectorDecision> {
      if (!server.clientSupportsElicitation) return reject(AVL.id, NO_CHANNEL_REASON);
      let result: unknown;
      try {
        result = await server.request(
          "elicitation/create",
          { message: escalationMessage(request), requestedSchema: ELICITATION_SCHEMA },
          timeoutMs,
        );
      } catch (error) {
        return reject(AVL.id, `the Director was not reached (${message(error)}); escalation fails closed`);
      }
      return decisionFromElicitation(result);
    },
  };
}

export function mcpTools(loadout: readonly ToolDefinition[]): McpTool[] {
  return [
    ...loadout.map((tool) => ({
      name: `${TOOL_PREFIX}${tool.name}`,
      description: `${tool.description}${GOVERNED_NOTE}`,
      inputSchema: tool.input_schema,
    })),
    {
      name: STATUS_TOOL,
      description: "Show this GRU episode's id, safety mode and the Project Director's task.",
      inputSchema: NO_INPUT,
    },
    {
      name: CLOSE_TOOL,
      description:
        "Run the Project Director's verification contract, close the episode and return the closure report. " +
        "Call it when the task is done. isError is true unless the closure is PASS.",
      inputSchema: NO_INPUT,
    },
  ];
}

function toolResult(text: string, isError: boolean): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

export class McpServer implements ElicitationPeer {
  readonly director: DirectorChannel;
  /** Resolves when the hook daemon is listening (immediately without a socket). */
  readonly ready: Promise<void>;
  /** Resolves with the episode report once the server has closed (explicitly or at end of input). */
  readonly closed: Promise<EpisodeReport | null>;

  readonly #options: McpServerOptions;
  readonly #peer: JsonRpcPeer;
  readonly #log: (line: string) => void;
  #elicitation = false;
  #session: Promise<GovernedSession> | null = null;
  #opened: GovernedSession | null = null;
  #daemon: HookDaemon | null = null;
  #closing: Promise<EpisodeReport | null> | null = null;
  #settleClosed: (value: Promise<EpisodeReport | null>) => void = () => {};

  constructor(options: McpServerOptions) {
    if (options.socketPath !== undefined && options.hostContext === undefined) {
      throw new Error("the hook daemon needs hostContext (workspace root and declared commands)");
    }
    this.#options = options;
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.director = elicitationDirector(this, options.elicitationTimeoutMs ?? ELICITATION_TIMEOUT_MS);
    this.closed = new Promise((resolve) => {
      this.#settleClosed = resolve;
    });
    this.closed.catch(() => {});

    const requests = new Map<string, RequestHandler>([
      ["initialize", (params) => this.#initialize(params)],
      ["ping", () => ({})],
      ["tools/list", () => ({ tools: mcpTools(this.#opened?.tools ?? toolDefinitions(options.commandIds)) })],
      ["tools/call", (params, id) => this.#callTool(params, id)],
    ]);
    this.#peer = new JsonRpcPeer({
      input: options.input,
      output: options.output,
      requests,
      log: this.#log,
      onEnd: () => {
        this.close().catch((error: unknown) => this.#log(`gru mcp: closing at end of input failed: ${message(error)}`));
      },
    });

    this.ready =
      options.socketPath !== undefined && options.hostContext !== undefined
        ? startHookDaemon({
            socketPath: options.socketPath,
            getSession: () => this.getSession(),
            ctx: options.hostContext,
            log: this.#log,
          }).then((daemon) => {
            this.#daemon = daemon;
          })
        : Promise.resolve();
    this.ready.catch((error: unknown) => this.#log(`gru mcp: hook daemon did not start: ${message(error)}`));
  }

  get clientSupportsElicitation(): boolean {
    return this.#elicitation;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.#peer.request(method, params, timeoutMs);
  }

  /** The one session shared by MCP tools and hooks, opened at most once. A failed open stays failed. */
  getSession(): Promise<GovernedSession> {
    this.#session ??= this.#options.openSession({ director: this.director }).then((session) => {
      this.#opened = session;
      return session;
    });
    return this.#session;
  }

  /** Stop the daemon and close the episode with HOST_ENDED (idempotent in the kernel). Idempotent. */
  close(): Promise<EpisodeReport | null> {
    this.#closing ??= (async () => {
      this.#peer.close();
      try {
        await this.ready;
      } catch {
        // already logged; nothing to stop
      }
      await this.#daemon?.close();
      if (this.#session === null) return null;
      let session: GovernedSession;
      try {
        session = await this.#session;
      } catch {
        return null; // the session never opened, so there is no episode to close
      }
      return session.close("HOST_ENDED");
    })();
    this.#settleClosed(this.#closing);
    return this.#closing;
  }

  #initialize(params: unknown): object {
    if (!isRecord(params)) throw new RpcError(INVALID_PARAMS, "initialize needs params");
    this.#elicitation = isRecord(params.capabilities) && isRecord(params.capabilities.elicitation);
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
      instructions: INSTRUCTIONS,
    };
  }

  async #callTool(params: unknown, id: JsonRpcId): Promise<object> {
    if (!isRecord(params) || typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call needs a string params.name");
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isRecord(args)) throw new RpcError(INVALID_PARAMS, "tools/call arguments must be an object");
    const name = params.name;
    if (!name.startsWith(TOOL_PREFIX)) return toolResult(`unknown tool "${name}"; GRU's tools are named ${TOOL_PREFIX}*`, true);

    let session: GovernedSession;
    try {
      session = await this.getSession();
    } catch (error) {
      return toolResult(`the GRU session could not be opened: ${message(error)}`, true);
    }
    try {
      if (name === STATUS_TOOL) {
        const status = { episode_id: session.episode_id, safety: session.safety, task: session.contract.task };
        return toolResult(JSON.stringify(status, null, 2), false);
      }
      if (name === CLOSE_TOOL) {
        const report = await session.close("HOST_ENDED");
        return toolResult(JSON.stringify(report, null, 2), report.closure.status !== "PASS");
      }
      // Any other gru_* name goes to the kernel, which denies and records an unknown tool itself.
      const result = await session.handle({ id: String(id), name: name.slice(TOOL_PREFIX.length), input: args });
      return toolResult(result.content, !result.ok);
    } catch (error) {
      return toolResult(`GRU could not complete ${name}: ${message(error)}`, true);
    }
  }
}

export function startMcpServer(options: McpServerOptions): McpServer {
  return new McpServer(options);
}
