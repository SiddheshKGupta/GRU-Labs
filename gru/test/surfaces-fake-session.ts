// A GovernedSession double for the surfaces tests. It records every call
// and answers from a script, so a test can assert exactly what a surface
// asked the kernel to do. It governs nothing.

import type { Readable } from "node:stream";
import type { Effect, ToolDefinition } from "../src/avl/actions.ts";
import { toolDefinitions } from "../src/avl/actions.ts";
import type { DeclaredCommand } from "../src/avl/consequence.ts";
import type { Json } from "../src/ledger/canonical.ts";
import type {
  ClosureStatus,
  DirectorChannel,
  EpisodeReport,
  GovernedSession,
  HostDecision,
  LoopOutcome,
  ModelTurn,
  SafetyMode,
  TaskContract,
  ToolCall,
  ToolResult,
} from "../src/types.ts";

export function declaredCommand(id: string, argv: string[]): DeclaredCommand {
  return { id, argv, consequences: ["EXECUTE_WORKSPACE_CODE"], writes: [], deletes: [], timeout_ms: 1000, env: {} };
}

export function fakeContract(commands: DeclaredCommand[] = [declaredCommand("test", ["npm", "test"])]): TaskContract {
  return {
    task: "Make the failing test pass",
    classification: "MICRO",
    success_criteria: ["tests pass"],
    grant: { scopes: ["workspace:read", "workspace:write"], ttl_seconds: 600 },
    commands,
    verification: { required_strength: null, protected: ["test/**"], checks: [], must_fail: [] },
    ignore: [],
    budget: { max_turns: 10, max_tool_calls: 20 },
  };
}

export const UNSAFE: SafetyMode = { mode: "UNSAFE_DEVELOPMENT", unmet: ["P1", "P2", "P8"], backends: [] };

export function fakeReport(status: ClosureStatus, episodeId = "ep-fake"): EpisodeReport {
  return {
    episode_id: episodeId,
    closure: { status, rationale: `fake ${status}` },
    verification: {
      outcome: status === "PASS" ? "PASS" : "FAIL",
      strength: "CHECKED",
      required: "CHECKED",
      checks: [],
      must_fail: [],
      protected_unchanged: true,
    },
    admissibility: { verdict: "UNRESOLVED", conditions: {} },
    safety: UNSAFE,
    violations: [],
    ledger_path: null,
  };
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeScript {
  /** Verdict per host tool name for decideHost; default ALLOW. */
  verdicts?: Record<string, HostDecision["verdict"]>;
  decideHostError?: string;
  handle?: (call: ToolCall, director: DirectorChannel | null) => Promise<ToolResult> | ToolResult;
  closure?: ClosureStatus;
}

export class FakeSession implements GovernedSession {
  readonly episode_id = "ep-fake";
  readonly safety = UNSAFE;
  readonly contract: TaskContract;
  readonly tools: readonly ToolDefinition[];
  readonly calls: FakeCall[] = [];
  readonly #script: FakeScript;
  readonly #director: DirectorChannel | null;
  #nextAuthorization = 1;

  constructor(script: FakeScript = {}, contract: TaskContract = fakeContract(), director: DirectorChannel | null = null) {
    this.#script = script;
    this.contract = contract;
    this.tools = toolDefinitions(contract.commands.map((command) => command.id));
    this.#director = director;
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async handle(call: ToolCall): Promise<ToolResult> {
    this.calls.push({ method: "handle", args: [call] });
    if (this.#script.handle) return this.#script.handle(call, this.#director);
    return { call_id: call.id, ok: true, content: `handled ${call.name}` };
  }

  recordTurn(turn: ModelTurn): void {
    this.calls.push({ method: "recordTurn", args: [turn] });
  }

  async decideHost(tool: string, effect: Effect): Promise<HostDecision> {
    this.calls.push({ method: "decideHost", args: [tool, effect] });
    if (this.#script.decideHostError) throw new Error(this.#script.decideHostError);
    const verdict = this.#script.verdicts?.[tool] ?? "ALLOW";
    return {
      authorization_id: `auth-${this.#nextAuthorization++}`,
      verdict,
      reasons: [verdict === "ALLOW" ? "every obligation is met by an active grant" : `fake ${verdict}`],
      consequences: effect.kind === "fs.read" ? ["OBSERVE_WORKSPACE"] : ["EXECUTE_UNDECLARED"],
    };
  }

  recordHostEffect(authorization_id: string, result: { ok: boolean; summary: Json; output: string | null }): void {
    this.calls.push({ method: "recordHostEffect", args: [authorization_id, result] });
  }

  revoke(grant_id: string, actor: string, reason: string): void {
    this.calls.push({ method: "revoke", args: [grant_id, actor, reason] });
  }

  async close(outcome: LoopOutcome): Promise<EpisodeReport> {
    this.calls.push({ method: "close", args: [outcome] });
    return fakeReport(this.#script.closure ?? "PASS", this.episode_id);
  }
}

// ---------------------------------------------------------------- stream support

/** Parsed JSON whose shape each test asserts. */
export type Message = any;

/** Collects newline-delimited JSON from a stream; `next` takes the first unconsumed match. */
export class Lines {
  readonly all: Message[] = [];
  readonly #queue: Message[] = [];
  readonly #waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  #buffer = "";

  constructor(stream: Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#deliver(JSON.parse(line));
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  #deliver(message: Message): void {
    this.all.push(message);
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      this.#queue.push(message);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    waiter?.resolve(message);
  }

  next(predicate: (message: Message) => boolean = () => true, timeoutMs = 3000): Promise<Message> {
    const index = this.#queue.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.#queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching message")), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

export function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
