// The deterministic fixture route: a scripted model for every test.
//
// The kernel must be testable with no credentials and no network (CDR-002),
// so this route replays a script of turns and never performs I/O. It is
// also a witness: each session keeps a copy of every input it received, so
// a test can assert exactly what AVL handed back to "the model".
//
// Honest limits: a script is not a model. It cannot react to what AVL
// returns, so it proves the kernel's handling of a given sequence of turns,
// not how a real model would behave after a denial. It reports its served
// model as "scripted" whatever descriptor it is given, so a fixture episode
// can never be mistaken for a live one in the ledger.

import type { ToolDefinition } from "../avl/actions.ts";
import type {
  ModelRoute,
  ModelTurn,
  RouteDescriptor,
  RouteSession,
  StopKind,
  ToolCall,
  ToolResult,
} from "../types.ts";

export interface FixtureTurn {
  text?: string;
  calls?: { name: string; input: unknown }[];
  stop?: StopKind;
}

export interface FixtureScript {
  turns: FixtureTurn[];
}

export class FixtureError extends Error {
  override name = "FixtureError";
}

const STOP_KINDS: readonly StopKind[] = ["end_turn", "tool_use", "refusal", "max_tokens", "other"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new FixtureError(`${at}: unknown key "${key}"`);
  }
}

/** Validate a fixture script strictly and return an independent copy of it. */
export function loadFixture(json: unknown): FixtureScript {
  if (!isRecord(json)) throw new FixtureError("fixture: must be an object");
  onlyKeys(json, ["turns"], "fixture");
  const rawTurns = json.turns;
  if (!Array.isArray(rawTurns)) throw new FixtureError("fixture.turns: must be an array");
  const turns = rawTurns.map((raw: unknown, turnIndex: number): FixtureTurn => {
    const at = `fixture.turns[${turnIndex}]`;
    if (!isRecord(raw)) throw new FixtureError(`${at}: must be an object`);
    onlyKeys(raw, ["text", "calls", "stop"], at);
    const turn: FixtureTurn = {};
    const text = raw.text;
    if (text !== undefined) {
      if (typeof text !== "string") throw new FixtureError(`${at}.text: must be a string`);
      turn.text = text;
    }
    const calls = raw.calls;
    if (calls !== undefined) {
      if (!Array.isArray(calls)) throw new FixtureError(`${at}.calls: must be an array`);
      turn.calls = calls.map((call: unknown, callIndex: number) => {
        const callAt = `${at}.calls[${callIndex}]`;
        if (!isRecord(call)) throw new FixtureError(`${callAt}: must be an object`);
        onlyKeys(call, ["name", "input"], callAt);
        const name = call.name;
        if (typeof name !== "string" || name === "") {
          throw new FixtureError(`${callAt}.name: must be a non-empty string`);
        }
        if (call.input === undefined) throw new FixtureError(`${callAt}.input: required`);
        // Input is deliberately unconstrained: fixtures exist to feed AVL malformed input.
        return { name, input: structuredClone(call.input) };
      });
    }
    const stop = raw.stop;
    if (stop !== undefined) {
      if (typeof stop !== "string" || !(STOP_KINDS as readonly string[]).includes(stop)) {
        throw new FixtureError(`${at}.stop: must be one of ${STOP_KINDS.join(", ")}`);
      }
      turn.stop = stop as StopKind;
    }
    return turn;
  });
  return { turns };
}

export const FIXTURE_DESCRIPTOR: RouteDescriptor = Object.freeze({
  id: "fixture/scripted",
  kind: "fixture",
  provider: "fixture",
  model: "scripted",
  base_url: null,
  credential_ref: null,
});

const SERVED_MODEL = "scripted";

export interface FixtureInput {
  results: ToolResult[];
  user?: string;
}

export class FixtureSession implements RouteSession {
  /** What open() was given. */
  readonly opened: { system: string; task: string; tools: ToolDefinition[] };
  /** Every input next() received, deep-copied at the moment it arrived. */
  readonly received: FixtureInput[] = [];
  readonly #script: FixtureScript;
  #cursor = 0;

  constructor(script: FixtureScript, opened: { system: string; task: string; tools: readonly ToolDefinition[] }) {
    this.#script = script;
    this.opened = structuredClone({ system: opened.system, task: opened.task, tools: [...opened.tools] });
  }

  async next(input: { results: readonly ToolResult[]; user?: string }): Promise<ModelTurn> {
    const record: FixtureInput = { results: structuredClone([...input.results]) };
    if (input.user !== undefined) record.user = input.user;
    this.received.push(record);

    const turnIndex = this.#cursor;
    const turn = this.#script.turns[turnIndex];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    if (turn === undefined) {
      return { text: "", calls: [], stop: "end_turn", served_model: SERVED_MODEL, usage, detail: null };
    }
    this.#cursor += 1;
    const calls: ToolCall[] = (turn.calls ?? []).map((call, index) => ({
      id: `fx-${turnIndex}-${index}`,
      name: call.name,
      input: structuredClone(call.input),
    }));
    const stop: StopKind = turn.stop ?? (calls.length > 0 ? "tool_use" : "end_turn");
    return { text: turn.text ?? "", calls, stop, served_model: SERVED_MODEL, usage, detail: null };
  }
}

export class FixtureRoute implements ModelRoute {
  readonly descriptor: RouteDescriptor;
  /** Every session this route opened, in order. Each replays the script from its first turn. */
  readonly sessions: FixtureSession[] = [];
  readonly #script: FixtureScript;

  constructor(script: FixtureScript, descriptor: RouteDescriptor = FIXTURE_DESCRIPTOR) {
    // Re-validating also copies, so a caller mutating its script later changes nothing here.
    this.#script = loadFixture(script);
    this.descriptor = Object.freeze({ ...descriptor });
  }

  open(input: { system: string; task: string; tools: readonly ToolDefinition[] }): FixtureSession {
    const session = new FixtureSession(this.#script, input);
    this.sessions.push(session);
    return session;
  }
}
