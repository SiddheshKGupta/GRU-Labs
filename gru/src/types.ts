// Cross-block contracts -- the "studs" every GRU block plugs into.
//
// FROZEN for slice 1. Owned by the integration owner. A block that needs a
// change here reports it as an unresolved issue instead of editing it;
// that is what keeps blocks independently replaceable (GRU §4 principle 3,
// §17 "no second internal ontology").
//
// Blocks:
//   kernel     session.ts, avl/*, ledger/*        opens and governs episodes
//   executor   executors/*                        performs authorized effects
//   route      routes/*                           talks to a model API
//   director   director/*                         brings the human in
//   surface    cli/, mcp/, hooks/                 terminal, MCP server, host hooks

import type { Effect, ToolDefinition } from "./avl/actions.ts";
import type { Consequence, DeclaredCommand } from "./avl/consequence.ts";
import type { AuthorizedAction, Binding } from "./avl/gate.ts";
import type { Principal } from "./avl/principal.ts";
import type { Json } from "./ledger/canonical.ts";
import type { Clock } from "./ledger/ledger.ts";

// ---------------------------------------------------------------- contract

export type Classification = "MICRO" | "MATERIAL" | "PROGRAM";
export const STRENGTHS = ["NONE", "ASSERTED", "CHECKED", "INDEPENDENT", "ADVERSARIAL"] as const;
export type Strength = (typeof STRENGTHS)[number];

export interface CheckSpec {
  id: string;
  argv: string[];
  timeout_ms: number;
  env: Record<string, string>;
}

/** Authored by the Project Director (T0) before the episode. Loaded once, hashed, never re-read. */
export interface TaskContract {
  task: string;
  classification: Classification;
  success_criteria: string[];
  grant: { scopes: string[]; ttl_seconds: number };
  commands: DeclaredCommand[];
  verification: {
    /** May raise the floor for the classification, never lower it. */
    required_strength: Strength | null;
    protected: string[];
    checks: CheckSpec[];
    must_fail: CheckSpec[];
  };
  ignore: string[];
  budget: { max_turns: number; max_tool_calls: number };
}

export interface SafetyMode {
  mode: "GOVERNED" | "UNSAFE_DEVELOPMENT";
  /** Threat-model properties no admitted isolation backend satisfies. */
  unmet: string[];
  backends: string[];
}

// ---------------------------------------------------------------- executor

export interface ProcessOutcome {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export interface EffectOutput {
  label: string;
  bytes: string;
  relation: "SUPPORTS" | "FALSIFIES" | "VERIFIES" | "DERIVED_FROM";
}

export interface EffectResult {
  ok: boolean;
  summary: Json;
  /** What the model sees. Information, never authority. */
  model_content: string;
  outputs: EffectOutput[];
}

export type Redeem = (action: AuthorizedAction, digestNow: string) => void;

export class BindError extends Error {
  override name = "BindError";
}

export interface EffectExecutor {
  /** realpath of the workspace root. */
  readonly root: string;
  /** Resolve an effect against the filesystem now. Throws BindError if it cannot be bound safely. */
  bind(effect: Effect): Binding;
  /**
   * Re-bind, compute effectDigest(effect, binding), call redeem BEFORE any
   * side effect, then act. Never performs host.* effects.
   */
  perform(action: AuthorizedAction, redeem: Redeem): Promise<EffectResult>;
  /** A verification run initiated by AVL (T1). argv only, no shell, scrubbed environment. */
  runCheck(check: CheckSpec): Promise<ProcessOutcome>;
  /** path -> sha256 of contents, or "symlink:<target>". Never follows symlinks. */
  manifest(ignore: readonly string[]): Map<string, string>;
}

// ---------------------------------------------------------------- route

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  call_id: string;
  ok: boolean;
  content: string;
}

export type StopKind = "end_turn" | "tool_use" | "refusal" | "max_tokens" | "other";

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
  stop: StopKind;
  /** The model that actually produced this turn (fallbacks can change it). */
  served_model: string;
  usage: TurnUsage;
  /** Refusal category, provider error text, etc. */
  detail: string | null;
}

export interface RouteSession {
  /**
   * First call: { results: [] } sends the task. Later calls return tool
   * results, or continue the conversation with a new user message.
   * History inside the session is append-only.
   */
  next(input: { results: readonly ToolResult[]; user?: string }): Promise<ModelTurn>;
}

export interface RouteDescriptor {
  id: string;
  kind: "fixture" | "anthropic" | "openai-compatible";
  provider: string;
  model: string;
  base_url: string | null;
  /** Where the credential comes from, e.g. "env:ANTHROPIC_API_KEY". Never the secret itself. */
  credential_ref: string | null;
}

export interface ModelRoute {
  readonly descriptor: RouteDescriptor;
  open(input: { system: string; task: string; tools: readonly ToolDefinition[] }): RouteSession;
}

export class RouteError extends Error {
  override name = "RouteError";
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, options: { retryable: boolean; status: number | null }) {
    super(message);
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** One entry in gru.config.json. Keys are referenced by env var, never stored. */
export interface ProviderConfig {
  id: string;
  kind: "anthropic" | "openai-compatible";
  base_url: string | null;
  api_key_env: string | null;
  default_model: string | null;
  models: string[];
  headers: Record<string, string>;
}

export interface ProbeResult {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
}

// ---------------------------------------------------------------- director

export interface EscalationRequest {
  authorization_id: string;
  proposal_id: string;
  principal: string;
  tool: string;
  effect: Effect;
  consequences: Consequence[];
  reasons: string[];
}

export interface DirectorDecision {
  decision: "APPROVE" | "REJECT";
  actor: string;
  reason: string;
}

export interface DirectorChannel {
  decide(request: EscalationRequest): Promise<DirectorDecision>;
}

// ---------------------------------------------------------------- kernel

export type LoopOutcome =
  | "COMPLETED"
  | "REFUSED"
  | "BUDGET_EXHAUSTED"
  | "ROUTE_ERROR"
  | "TRUNCATED"
  | "HOST_ENDED";

export type ClosureStatus = "PASS" | "FAIL" | "PARTIAL" | "ABANDONED";
export type AdmissibilityVerdict = "ADMISSIBLE_POSITIVE" | "ADMISSIBLE_NEGATIVE" | "INADMISSIBLE" | "UNRESOLVED";
export type ConditionResult = "PASS" | "FAIL" | "UNDECIDABLE";

export interface VerificationOutcome {
  outcome: "PASS" | "FAIL" | "NOT_RUN";
  strength: Strength;
  required: Strength;
  checks: { id: string; exit_code: number; passed: boolean; evidence_ref: string }[];
  must_fail: { id: string; exit_code: number; failed_as_required: boolean; evidence_ref: string }[];
  protected_unchanged: boolean;
}

export interface EpisodeReport {
  episode_id: string;
  closure: { status: ClosureStatus; rationale: string };
  verification: VerificationOutcome;
  admissibility: { verdict: AdmissibilityVerdict; conditions: Record<string, ConditionResult> };
  safety: SafetyMode;
  violations: string[];
  ledger_path: string | null;
}

/** What a host (Claude Code, Codex) is told about one of its own tool calls. */
export interface HostDecision {
  authorization_id: string;
  verdict: "ALLOW" | "DENY" | "ASK";
  reasons: string[];
  consequences: Consequence[];
}

export interface OpenSessionOptions {
  contract: TaskContract;
  workspace: string;
  /** Must not be inside the workspace. null keeps the ledger in memory (tests). */
  state_dir: string | null;
  /** null when a host drives the session (MCP, hooks) rather than a GRU route. */
  route: RouteDescriptor | null;
  director: DirectorChannel;
  minion: Principal;
  clock?: Clock;
  executor?: EffectExecutor;
  /** Isolation backends the Director has admitted. Empty in slice 1. */
  backends?: { id: string; provides: string[] }[];
}

export interface GovernedSession {
  readonly episode_id: string;
  readonly safety: SafetyMode;
  /** The Minion's loadout, derived from the contract. */
  readonly tools: readonly ToolDefinition[];
  readonly contract: TaskContract;
  /** The gate path: parse -> classify -> authorize -> (escalate) -> execute -> evidence. */
  handle(call: ToolCall): Promise<ToolResult>;
  /** Record a model turn: served model, usage, and its text as an ASSERTED claim. */
  recordTurn(turn: ModelTurn): void;
  /**
   * Host mode: classify and authorize an effect the host will perform
   * itself. ESCALATE becomes ASK so the host's own UI asks the Director.
   */
  decideHost(tool: string, effect: Effect): Promise<HostDecision>;
  /** Host mode: record that the host performed (or failed) an authorized effect. */
  recordHostEffect(authorization_id: string, result: { ok: boolean; summary: Json; output: string | null }): void;
  /** Director (T0) revokes a grant mid-episode. */
  revoke(grant_id: string, actor: string, reason: string): void;
  /** Reconcile, verify, validate, close and compute admissibility. Idempotent. */
  close(outcome: LoopOutcome): Promise<EpisodeReport>;
}

export type OpenSession = (options: OpenSessionOptions) => Promise<GovernedSession>;
