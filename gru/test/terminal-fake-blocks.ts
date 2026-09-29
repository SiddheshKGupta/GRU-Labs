// Fakes for the terminal block's tests: a recording session, scripted
// routes, a catalog and a Blocks object that logs the order it is used in.
// Nothing here governs anything; the fakes exist so the surface can be
// tested without the kernel, executor or route blocks.

import { PassThrough } from "node:stream";
import type { Effect, ToolDefinition } from "../src/avl/actions.ts";
import { toolDefinitions } from "../src/avl/actions.ts";
import type { DeclaredCommand } from "../src/avl/consequence.ts";
import type {
  Blocks,
  ClosureStatus,
  CredentialStatus,
  DirectorChannel,
  EffectExecutor,
  EpisodeReport,
  EscalationRequest,
  GovernedSession,
  HostDecision,
  LoopOutcome,
  ModelRoute,
  ModelTurn,
  OpenSessionOptions,
  ProbeResult,
  ProviderCatalog,
  ProviderConfig,
  RouteDescriptor,
  RouteSession,
  SafetyMode,
  TaskContract,
  ToolCall,
  ToolResult,
} from "../src/types.ts";
import type { Io } from "../src/cli/main.ts";

export function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task: "Do the thing.",
    classification: "MATERIAL",
    success_criteria: [],
    grant: { scopes: ["workspace:read", "workspace:write"], ttl_seconds: 3600 },
    commands: [],
    verification: { required_strength: null, protected: [], checks: [], must_fail: [] },
    ignore: [],
    budget: { max_turns: 20, max_tool_calls: 40 },
    ...overrides,
  };
}

export function command(id: string): DeclaredCommand {
  return { id, argv: ["node", "--version"], consequences: ["EXECUTE_WORKSPACE_CODE"], writes: [], deletes: [], timeout_ms: 1000, env: {} };
}

export function turn(partial: Partial<ModelTurn> = {}): ModelTurn {
  const calls = partial.calls ?? [];
  return {
    text: "",
    calls,
    stop: calls.length > 0 ? "tool_use" : "end_turn",
    served_model: "fake-model",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    detail: null,
    ...partial,
  };
}

export function call(id: string, name = "read_file", input: unknown = { path: "README.md" }): ToolCall {
  return { id, name, input };
}

export const UNSAFE: SafetyMode = { mode: "UNSAFE_DEVELOPMENT", unmet: ["P1", "P2", "P8"], backends: [] };

export function report(status: ClosureStatus, overrides: Partial<EpisodeReport> = {}): EpisodeReport {
  return {
    episode_id: "ep-fake-1",
    closure: { status, rationale: `fake closure ${status}` },
    verification: {
      outcome: status === "PASS" ? "PASS" : "FAIL",
      strength: status === "PASS" ? "INDEPENDENT" : "NONE",
      required: "INDEPENDENT",
      checks: [{ id: "unit", exit_code: status === "PASS" ? 0 : 1, passed: status === "PASS", evidence_ref: "sha256:abc" }],
      must_fail: [],
      protected_unchanged: true,
    },
    admissibility: { verdict: "UNRESOLVED", conditions: {} },
    safety: UNSAFE,
    violations: [],
    ledger_path: "/state/episodes/ep-fake-1/ledger.jsonl",
    ...overrides,
  };
}

export function descriptor(overrides: Partial<RouteDescriptor> = {}): RouteDescriptor {
  return {
    id: "fixture:fake",
    kind: "fixture",
    provider: "fixture",
    model: "fake-model",
    base_url: null,
    credential_ref: null,
    ...overrides,
  };
}

/** A route that replays scripted turns; an Error entry is thrown instead of returned. */
export class FakeRoute implements ModelRoute {
  readonly descriptor: RouteDescriptor;
  readonly opened: { system: string; task: string; tools: readonly ToolDefinition[] }[] = [];
  readonly inputs: { results: readonly ToolResult[]; user?: string }[] = [];
  readonly openError: Error | null;
  readonly #script: (ModelTurn | Error)[];
  readonly #log: string[] | undefined;
  #index = 0;

  constructor(script: (ModelTurn | Error)[], options: { descriptor?: RouteDescriptor; log?: string[]; openError?: Error } = {}) {
    this.#script = script;
    this.descriptor = options.descriptor ?? descriptor();
    this.#log = options.log;
    this.openError = options.openError ?? null;
  }

  open(input: { system: string; task: string; tools: readonly ToolDefinition[] }): RouteSession {
    this.#log?.push("route.open");
    if (this.openError !== null) throw this.openError;
    this.opened.push(input);
    return {
      next: async (next) => {
        this.#log?.push("route.next");
        this.inputs.push(next);
        const entry = this.#script[this.#index++];
        if (entry === undefined) throw new Error("fake route script exhausted");
        if (entry instanceof Error) throw entry;
        return entry;
      },
    };
  }
}

export interface FakeSessionOptions {
  contract?: TaskContract;
  report?: EpisodeReport;
  /** Result for each handled call; defaults to ok with "result of <id>". */
  handle?: (call: ToolCall) => ToolResult;
  /** Calls for which the fake asks the Director before answering. */
  escalate?: (call: ToolCall) => Omit<EscalationRequest, "authorization_id" | "proposal_id" | "principal"> | null;
  director?: DirectorChannel;
  log?: string[];
}

export class FakeSession implements GovernedSession {
  readonly episode_id: string;
  readonly safety: SafetyMode = UNSAFE;
  readonly tools: readonly ToolDefinition[];
  readonly contract: TaskContract;
  readonly handled: ToolCall[] = [];
  readonly turns: ModelTurn[] = [];
  readonly closed: LoopOutcome[] = [];
  readonly decisions: { request: EscalationRequest; decision: string }[] = [];
  readonly #options: FakeSessionOptions;

  constructor(options: FakeSessionOptions = {}) {
    this.#options = options;
    this.contract = options.contract ?? contract();
    this.episode_id = options.report?.episode_id ?? "ep-fake-1";
    this.tools = toolDefinitions(this.contract.commands.map((c) => c.id));
  }

  async handle(call: ToolCall): Promise<ToolResult> {
    this.#options.log?.push(`session.handle:${call.id}`);
    this.handled.push(call);
    const escalation = this.#options.escalate?.(call) ?? null;
    if (escalation !== null) {
      const director = this.#options.director;
      if (director === undefined) throw new Error("fake session has no director");
      const request: EscalationRequest = {
        authorization_id: `auth-${call.id}`,
        proposal_id: `prop-${call.id}`,
        principal: "minion:implementer",
        ...escalation,
      };
      const decision = await director.decide(request);
      this.decisions.push({ request, decision: decision.decision });
      return { call_id: call.id, ok: decision.decision === "APPROVE", content: `director ${decision.decision}: ${decision.reason}` };
    }
    return this.#options.handle?.(call) ?? { call_id: call.id, ok: true, content: `result of ${call.id}` };
  }

  recordTurn(turn: ModelTurn): void {
    this.#options.log?.push("session.recordTurn");
    this.turns.push(turn);
  }

  async decideHost(_tool: string, _effect: Effect): Promise<HostDecision> {
    throw new Error("not used by the terminal block");
  }

  recordHostEffect(): void {
    throw new Error("not used by the terminal block");
  }

  revoke(): void {
    throw new Error("not used by the terminal block");
  }

  async close(outcome: LoopOutcome): Promise<EpisodeReport> {
    this.#options.log?.push(`session.close:${outcome}`);
    this.closed.push(outcome);
    return this.#options.report ?? report("PASS");
  }
}

export class FakeCatalog implements ProviderCatalog {
  readonly routed: string[] = [];
  readonly configs: readonly ProviderConfig[];
  readonly #routes: (spec: string) => ModelRoute;
  readonly #credentials: Record<string, CredentialStatus>;

  constructor(
    configs: readonly ProviderConfig[],
    options: { route?: (spec: string) => ModelRoute; credentials?: Record<string, CredentialStatus> } = {},
  ) {
    this.configs = configs;
    this.#routes = options.route ?? ((spec) => new FakeRoute([turn({ text: "done" })], { descriptor: descriptor({ id: spec, provider: spec.split("/")[0] ?? spec, model: spec.split("/")[1] ?? "default", kind: "anthropic" }) }));
    this.#credentials = options.credentials ?? {};
  }

  list(): { config: ProviderConfig; credential: CredentialStatus }[] {
    return this.configs.map((config) => ({ config, credential: this.#credentials[config.id] ?? "MISSING" }));
  }

  route(spec: string): ModelRoute {
    if (!this.configs.some((config) => config.id === spec.split("/")[0])) throw new Error(`unknown provider in route ${spec}`);
    this.routed.push(spec);
    return this.#routes(spec);
  }

  async discover(providerId: string): Promise<string[]> {
    return [`${providerId}-model-a`, `${providerId}-model-b`];
  }

  async probe(providerId: string, model: string): Promise<ProbeResult> {
    return { provider: providerId, model, ok: model.endsWith("-b"), latency_ms: 12, error: model.endsWith("-b") ? null : "404 not found" };
  }

  async autoSelect(providerId: string): Promise<{ model: string; probes: ProbeResult[] }> {
    const probes = [await this.probe(providerId, `${providerId}-model-a`), await this.probe(providerId, `${providerId}-model-b`)];
    return { model: `${providerId}-model-b`, probes };
  }
}

export function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: "anthropic",
    base_url: "https://api.example.test/v1",
    api_key_env: `${id.toUpperCase()}_API_KEY`,
    default_model: `${id}-model-b`,
    models: [],
    headers: {},
    ...overrides,
  };
}

export const FAKE_EXECUTOR: EffectExecutor = {
  root: "/fake",
  bind: () => ({}),
  perform: async () => {
    throw new Error("fake executor does not perform");
  },
  runCheck: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, timed_out: false }),
  manifest: () => new Map(),
};

export interface FakeBlocksOptions {
  /** Turns every created route replays. */
  script?: () => (ModelTurn | Error)[];
  report?: EpisodeReport;
  providers?: readonly ProviderConfig[];
  credentials?: Record<string, CredentialStatus>;
  escalate?: FakeSessionOptions["escalate"];
  handle?: FakeSessionOptions["handle"];
  openSessionError?: Error;
}

export interface FakeBlocks {
  blocks: Blocks;
  log: string[];
  sessions: FakeSession[];
  openOptions: OpenSessionOptions[];
  contracts: unknown[];
  fixtures: unknown[];
  executors: { root: string; commands: readonly DeclaredCommand[] }[];
  catalogs: FakeCatalog[];
  routes: FakeRoute[];
}

export function fakeBlocks(options: FakeBlocksOptions = {}): FakeBlocks {
  const state: FakeBlocks = {
    blocks: undefined as unknown as Blocks,
    log: [],
    sessions: [],
    openOptions: [],
    contracts: [],
    fixtures: [],
    executors: [],
    catalogs: [],
    routes: [],
  };
  const script = options.script ?? (() => [turn({ calls: [call("c1")] }), turn({ text: "All done." })]);
  const makeRoute = (routeDescriptor: RouteDescriptor): FakeRoute => {
    const route = new FakeRoute(script(), { descriptor: routeDescriptor, log: state.log });
    state.routes.push(route);
    return route;
  };
  state.blocks = {
    async openSession(open: OpenSessionOptions) {
      state.log.push("openSession");
      state.openOptions.push(open);
      if (options.openSessionError) throw options.openSessionError;
      const session = new FakeSession({
        contract: open.contract,
        report: options.report ?? report("PASS"),
        escalate: options.escalate,
        handle: options.handle,
        director: open.director,
        log: state.log,
      });
      state.sessions.push(session);
      return session;
    },
    executor(root, commands) {
      state.log.push("executor");
      state.executors.push({ root, commands });
      return FAKE_EXECUTOR;
    },
    catalog(configs) {
      state.log.push("catalog");
      const catalog = new FakeCatalog(configs.length > 0 ? configs : options.providers ?? [], {
        credentials: options.credentials,
        route: (spec) => makeRoute(descriptor({ id: spec, kind: "anthropic", provider: spec.split("/")[0] ?? spec, model: spec.split("/")[1] ?? "default" })),
      });
      state.catalogs.push(catalog);
      return catalog;
    },
    fixtureRoute(fixture) {
      state.log.push("fixtureRoute");
      state.fixtures.push(fixture);
      return makeRoute(descriptor());
    },
    parseContract(json) {
      state.log.push("parseContract");
      state.contracts.push(json);
      if (typeof json !== "object" || json === null) throw new Error("contract must be an object");
      const raw = json as Record<string, unknown>;
      if (typeof raw.task !== "string") throw new Error("contract.task must be a string");
      const verification = (raw.verification ?? {}) as Partial<TaskContract["verification"]>;
      return contract({
        task: raw.task,
        commands: (raw.commands as DeclaredCommand[] | undefined) ?? [],
        verification: {
          required_strength: null,
          protected: verification.protected ?? [],
          checks: verification.checks ?? [],
          must_fail: verification.must_fail ?? [],
        },
      });
    },
  };
  return state;
}

export interface TestIo {
  io: Io;
  stdin: PassThrough;
  stdout(): string;
  stderr(): string;
  /** Resolves once stdout contains `text`. */
  waitFor(text: string): Promise<void>;
}

export function testIo(options: { isTTY?: boolean; env?: Record<string, string | undefined>; cwd?: string } = {}): TestIo {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  const watchers: { text: string; resolve: () => void }[] = [];
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
    for (const watcher of [...watchers]) {
      if (out.includes(watcher.text)) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  return {
    io: {
      stdin,
      stdout,
      stderr,
      env: options.env ?? { HOME: "/nonexistent-home-for-tests" },
      cwd: options.cwd ?? "/nonexistent-cwd-for-tests",
      isTTY: options.isTTY ?? false,
    },
    stdin,
    stdout: () => out,
    stderr: () => err,
    waitFor(text: string) {
      if (out.includes(text)) return Promise.resolve();
      return new Promise((resolve) => watchers.push({ text, resolve }));
    },
  };
}

export function escalationRequest(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    authorization_id: "auth-1",
    proposal_id: "prop-1",
    principal: "minion:implementer",
    tool: "delete_file",
    effect: { kind: "fs.delete", path: "test/slugify.test.js" },
    consequences: ["DESTROY_WORKSPACE_DATA", "ALTER_VERIFICATION"],
    reasons: ["ALTER_VERIFICATION always requires Project Director approval"],
    ...overrides,
  };
}
