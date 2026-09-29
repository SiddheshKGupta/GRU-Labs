// Director channels: how an escalation reaches the Project Director (T0).
//
// Every channel fails closed. No channel, no matching scripted rule, an
// empty answer, anything but "y"/"yes", Ctrl-C or end of input: REJECT.
// A channel only answers the question AVL asks; it never widens a grant
// and never sees anything the model could use to answer on the Director's
// behalf.
//
// InteractiveDirector discards lines typed before the escalation card was
// printed, so an approval cannot come from type-ahead or from piped input
// written before the question existed. That is best-effort: bytes the
// operating system has not yet delivered when the card is printed are
// indistinguishable from an answer. Unattended runs belong on
// ScriptedDirector, whose rules the Director wrote in advance.
//
// Limit: the terminal channel trusts whoever holds the terminal. It
// authenticates nobody.

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isConsequence, type Consequence } from "../avl/consequence.ts";
import { matchesGlob } from "../avl/paths.ts";
import { AVL, principal } from "../avl/principal.ts";
import type { DirectorChannel, DirectorDecision, EscalationRequest } from "../types.ts";
import { PLAIN, renderEscalation, type Style } from "../cli/render.ts";

// ---------------------------------------------------------------- deny-all

export class DenyAllDirector implements DirectorChannel {
  async decide(_request: EscalationRequest): Promise<DirectorDecision> {
    return { decision: "REJECT", actor: AVL.id, reason: "no Director channel attached; escalations fail closed" };
  }
}

// ---------------------------------------------------------------- scripted

export interface DirectorRule {
  match: { tool?: string; path?: string; consequence?: Consequence };
  decision: "APPROVE" | "REJECT";
  reason: string;
}

export class DirectorScriptError extends Error {
  override name = "DirectorScriptError";
}

const SCRIPTED_ACTOR = principal("director", "scripted").id;

function effectPath(request: EscalationRequest): string | null {
  const effect = request.effect;
  return "path" in effect && typeof effect.path === "string" ? effect.path : null;
}

function ruleMatches(rule: DirectorRule, request: EscalationRequest): boolean {
  const { tool, path, consequence } = rule.match;
  if (tool !== undefined && request.tool !== tool) return false;
  if (consequence !== undefined && !request.consequences.includes(consequence)) return false;
  if (path !== undefined) {
    const actual = effectPath(request);
    if (actual === null || !matchesGlob(actual, path)) return false;
  }
  return true;
}

/** Decisions written in advance by the Director. First matching rule wins; no match rejects. */
export class ScriptedDirector implements DirectorChannel {
  readonly #rules: readonly DirectorRule[];

  constructor(rules: readonly DirectorRule[]) {
    this.#rules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule, match: Object.freeze({ ...rule.match }) })));
  }

  async decide(request: EscalationRequest): Promise<DirectorDecision> {
    const rule = this.#rules.find((candidate) => ruleMatches(candidate, request));
    if (rule === undefined) return { decision: "REJECT", actor: SCRIPTED_ACTOR, reason: "no scripted rule matched" };
    return { decision: rule.decision, actor: SCRIPTED_ACTOR, reason: rule.reason };
  }
}

function plainObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DirectorScriptError(`${at} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new DirectorScriptError(`${at} has unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new DirectorScriptError(`${at} must be a non-empty string`);
  return value;
}

/** Validate a Director script file: {"description"?: string, "rules": DirectorRule[]}. */
export function loadDirectorScript(json: unknown): DirectorRule[] {
  const root = plainObject(json, "director script");
  onlyKeys(root, ["description", "rules"], "director script");
  if (root.description !== undefined && typeof root.description !== "string") {
    throw new DirectorScriptError("director script.description must be a string");
  }
  if (!Array.isArray(root.rules)) throw new DirectorScriptError("director script.rules must be an array");
  return root.rules.map((raw, index): DirectorRule => {
    const at = `rules[${index}]`;
    const rule = plainObject(raw, at);
    onlyKeys(rule, ["match", "decision", "reason"], at);
    const match = plainObject(rule.match, `${at}.match`);
    onlyKeys(match, ["tool", "path", "consequence"], `${at}.match`);
    const parsed: DirectorRule["match"] = {};
    if (match.tool !== undefined) parsed.tool = nonEmptyString(match.tool, `${at}.match.tool`);
    if (match.path !== undefined) parsed.path = nonEmptyString(match.path, `${at}.match.path`);
    if (match.consequence !== undefined) {
      if (!isConsequence(match.consequence)) {
        throw new DirectorScriptError(`${at}.match.consequence is not a known consequence: ${JSON.stringify(match.consequence)}`);
      }
      parsed.consequence = match.consequence;
    }
    if (rule.decision !== "APPROVE" && rule.decision !== "REJECT") {
      throw new DirectorScriptError(`${at}.decision must be "APPROVE" or "REJECT"`);
    }
    return { match: parsed, decision: rule.decision, reason: nonEmptyString(rule.reason, `${at}.reason`) };
  });
}

// ---------------------------------------------------------------- terminal input

/**
 * A line queue over one input stream. The REPL and the interactive
 * Director share one of these, so a line is read by exactly one of them;
 * two readline interfaces on one stream would both see every keystroke.
 */
export class LineInput {
  readonly #rl: Interface;
  readonly #terminal: boolean;
  readonly #queue: string[] = [];
  #waiter: ((line: string | null) => void) | null = null;
  #closed = false;
  /** Called on Ctrl-C (terminal mode) while nobody is waiting for a line. */
  onIdleInterrupt: (() => void) | null = null;

  constructor(input: Readable, output: Writable, options: { terminal: boolean }) {
    this.#terminal = options.terminal;
    this.#rl = createInterface({ input, output, terminal: options.terminal, historySize: options.terminal ? 100 : 0 });
    this.#rl.on("line", (line) => {
      const waiter = this.#waiter;
      if (waiter !== null) {
        this.#waiter = null;
        waiter(line);
      } else {
        this.#queue.push(line);
      }
    });
    this.#rl.on("close", () => {
      this.#closed = true;
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter?.(null);
    });
    // Terminal mode only: Ctrl-C answers the pending question with an empty
    // line (which every caller treats as "no"), instead of pausing input.
    this.#rl.on("SIGINT", () => {
      const waiter = this.#waiter;
      if (waiter !== null) {
        this.#waiter = null;
        this.#rl.write(null, { ctrl: true, name: "e" });
        this.#rl.write(null, { ctrl: true, name: "u" });
        waiter("");
      } else {
        this.onIdleInterrupt?.();
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  /** Forget complete lines typed before now. */
  discardPending(): void {
    this.#queue.length = 0;
  }

  /** Show a prompt and resolve with the next line, or null at end of input. */
  ask(prompt: string): Promise<string | null> {
    if (this.#waiter !== null) return Promise.reject(new Error("LineInput.ask called while another question is pending"));
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#waiter = resolve;
      this.#rl.setPrompt(prompt);
      this.#rl.prompt();
    });
  }

  close(): void {
    if (!this.#closed) this.#rl.close();
  }
}

// ---------------------------------------------------------------- interactive

const TERMINAL_ACTOR = principal("director", "terminal").id;

export interface InteractiveDirectorOptions {
  /** A stream (the Director owns a reader on it) or a LineInput shared with a REPL. */
  input: Readable | LineInput;
  output: Writable;
  style?: Style;
}

export class InteractiveDirector implements DirectorChannel {
  readonly #output: Writable;
  readonly #style: Style;
  readonly #lines: LineInput;
  readonly #owned: boolean;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: InteractiveDirectorOptions) {
    this.#output = options.output;
    this.#style = options.style ?? PLAIN;
    if (options.input instanceof LineInput) {
      this.#lines = options.input;
      this.#owned = false;
    } else {
      // Not terminal mode: the TTY stays cooked, so Ctrl-C still reaches the
      // process and the kernel's line discipline handles echo and editing.
      this.#lines = new LineInput(options.input, options.output, { terminal: false });
      this.#owned = true;
    }
  }

  decide(request: EscalationRequest): Promise<DirectorDecision> {
    // One question at a time, even if a caller overlaps escalations.
    const next = this.#chain.then(() => this.#ask(request));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #ask(request: EscalationRequest): Promise<DirectorDecision> {
    this.#output.write(renderEscalation(request, this.#style));
    this.#lines.discardPending();
    const answer = await this.#lines.ask("Approve? [y/N] ");
    if (answer === null) {
      this.#output.write("\n");
      return { decision: "REJECT", actor: TERMINAL_ACTOR, reason: "input ended before an answer; rejected" };
    }
    const normalised = answer.trim().toLowerCase();
    const approve = normalised === "y" || normalised === "yes";
    const reason = await this.#lines.ask("Reason: ");
    if (reason === null) {
      this.#output.write("\n");
      return { decision: "REJECT", actor: TERMINAL_ACTOR, reason: "input ended before a reason was given; rejected" };
    }
    const stated = reason.trim();
    if (approve) {
      return { decision: "APPROVE", actor: TERMINAL_ACTOR, reason: stated === "" ? "approved at the terminal" : stated };
    }
    const why = normalised === "" || normalised === "n" || normalised === "no" ? "rejected at the terminal" : `answer "${answer.trim().slice(0, 40)}" is not y/yes; rejected`;
    return { decision: "REJECT", actor: TERMINAL_ACTOR, reason: stated === "" ? why : stated };
  }

  /** Release the reader if this Director created it. A shared LineInput stays open. */
  close(): void {
    if (this.#owned) this.#lines.close();
  }
}
