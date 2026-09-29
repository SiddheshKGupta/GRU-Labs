// The task contract parser (SLICE_1 §4.4): the Project Director (T0) states
// the task, the grant, the declared commands and the verification contract
// before the episode starts. It is parsed once, hashed into the opening
// event and never re-read.
//
// Strict by design. An unknown key is an error rather than ignored, because
// a misspelt "protected" that silently parsed as "no protected files" would
// weaken verification without anyone noticing. Defaults exist only where
// omitting a field cannot widen authority or weaken a check.
//
// Limit: the parser checks shape and internal consistency. It cannot tell
// whether the protected globs actually cover the files the checks read, or
// whether a declared command's argv does what its id suggests.

import { isConsequence, type Consequence, type DeclaredCommand } from "./avl/consequence.ts";
import { floorFor, isStrength, rank } from "./avl/verification.ts";
import type { CheckSpec, Classification, Strength, TaskContract } from "./types.ts";

export class ContractError extends Error {
  override name = "ContractError";
}

const CLASSIFICATIONS: readonly Classification[] = ["MICRO", "MATERIAL", "PROGRAM"];
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const SCOPE = /^(workspace:(read|write|delete)|command:[a-z0-9][a-z0-9_-]*)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_IGNORE = [".git/**", "node_modules/**"];
const DEFAULT_BUDGET = { max_turns: 30, max_tool_calls: 100 };

type Fields = Record<string, unknown>;

function plainObject(value: unknown, at: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError(`${at} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContractError(`${at} must be a plain object`);
  return value as Fields;
}

function fields(value: unknown, at: string, required: readonly string[], optional: readonly string[]): Fields {
  const record = plainObject(value, at);
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ContractError(`${at}.${key} is not a contract field`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) throw new ContractError(`${at}.${key} is required`);
  }
  return record;
}

function present(record: Fields, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContractError(`${at} must be a non-empty string`);
  return value;
}

function identifier(value: unknown, at: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new ContractError(`${at} must match ${ID.source}`);
  }
  return value;
}

function integer(value: unknown, at: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ContractError(`${at} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function list<T>(value: unknown, at: string, item: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) throw new ContractError(`${at} must be an array`);
  return value.map((entry, index) => item(entry, `${at}[${index}]`));
}

function glob(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ContractError(`${at} must be a non-empty glob without NUL`);
  }
  return value;
}

function argv(value: unknown, at: string): string[] {
  const parts = list(value, at, (entry, where) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new ContractError(`${where} must be a non-empty string without NUL`);
    }
    return entry;
  });
  if (parts.length === 0) throw new ContractError(`${at} must name a program`);
  return parts;
}

function env(value: unknown, at: string): Record<string, string> {
  const record = plainObject(value, at);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!ENV_NAME.test(key)) throw new ContractError(`${at}.${key} is not a valid environment variable name`);
    if (typeof entry !== "string" || entry.includes("\0")) throw new ContractError(`${at}.${key} must be a string without NUL`);
    result[key] = entry;
  }
  return result;
}

function unique(ids: readonly string[], at: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ContractError(`${at}: duplicate id "${id}"`);
    seen.add(id);
  }
}

function check(value: unknown, at: string): CheckSpec {
  const record = fields(value, at, ["id", "argv", "timeout_ms"], ["env"]);
  return {
    id: identifier(record.id, `${at}.id`),
    argv: argv(record.argv, `${at}.argv`),
    timeout_ms: integer(record.timeout_ms, `${at}.timeout_ms`, 1, 600_000),
    env: present(record, "env") ? env(record.env, `${at}.env`) : {},
  };
}

function command(value: unknown, at: string): DeclaredCommand {
  const record = fields(value, at, ["id", "argv", "consequences", "timeout_ms"], ["writes", "deletes", "env"]);
  const consequences = list(record.consequences, `${at}.consequences`, (entry, where): Consequence => {
    if (!isConsequence(entry)) throw new ContractError(`${where} is not a known consequence`);
    return entry;
  });
  return {
    id: identifier(record.id, `${at}.id`),
    argv: argv(record.argv, `${at}.argv`),
    consequences,
    writes: present(record, "writes") ? list(record.writes, `${at}.writes`, glob) : [],
    deletes: present(record, "deletes") ? list(record.deletes, `${at}.deletes`, glob) : [],
    timeout_ms: integer(record.timeout_ms, `${at}.timeout_ms`, 1, 600_000),
    env: present(record, "env") ? env(record.env, `${at}.env`) : {},
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export function parseContract(json: unknown): TaskContract {
  const top = fields(
    json,
    "contract",
    ["task", "classification", "grant", "commands", "verification"],
    ["success_criteria", "ignore", "budget"],
  );

  const task = text(top.task, "contract.task");
  if (!CLASSIFICATIONS.includes(top.classification as Classification)) {
    throw new ContractError(`contract.classification must be one of ${CLASSIFICATIONS.join(", ")}`);
  }
  const classification = top.classification as Classification;
  const success_criteria = present(top, "success_criteria")
    ? list(top.success_criteria, "contract.success_criteria", text)
    : [];

  const commands = list(top.commands, "contract.commands", command);
  unique(commands.map((entry) => entry.id), "contract.commands");
  const commandIds = new Set(commands.map((entry) => entry.id));

  const grantFields = fields(top.grant, "contract.grant", ["scopes", "ttl_seconds"], []);
  const scopes = list(grantFields.scopes, "contract.grant.scopes", (entry, at) => {
    if (typeof entry !== "string" || !SCOPE.test(entry)) throw new ContractError(`${at} is not a valid scope`);
    if (entry.startsWith("command:") && !commandIds.has(entry.slice("command:".length))) {
      throw new ContractError(`${at} grants ${entry}, but no such command is declared`);
    }
    return entry;
  });
  const ttl_seconds = integer(grantFields.ttl_seconds, "contract.grant.ttl_seconds", 1, 86_400);

  const verificationFields = fields(
    top.verification,
    "contract.verification",
    ["protected", "checks"],
    ["required_strength", "must_fail"],
  );
  let required_strength: Strength | null = null;
  if (present(verificationFields, "required_strength") && verificationFields.required_strength !== null) {
    const raised = verificationFields.required_strength;
    if (!isStrength(raised)) throw new ContractError("contract.verification.required_strength is not a known strength");
    const floor = floorFor(classification);
    if (rank(raised) < rank(floor)) {
      throw new ContractError(
        `contract.verification.required_strength ${raised} is below the ${classification} floor ${floor}; ` +
          "a contract may raise the floor, never lower it",
      );
    }
    required_strength = raised;
  }
  const checks = list(verificationFields.checks, "contract.verification.checks", check);
  const must_fail = present(verificationFields, "must_fail")
    ? list(verificationFields.must_fail, "contract.verification.must_fail", check)
    : [];
  // Checks and must-fail checks share one namespace: both label evidence.
  unique([...checks, ...must_fail].map((entry) => entry.id), "contract.verification checks and must_fail");
  const protectedGlobs = list(verificationFields.protected, "contract.verification.protected", glob);
  // INDEPENDENT means "no protected file changed"; with nothing protected it
  // would be reached without being earned.
  if (classification !== "MICRO" && checks.length > 0 && protectedGlobs.length === 0) {
    throw new ContractError(
      `a ${classification} contract with checks must protect the files they depend on ` +
        "(contract.verification.protected is empty)",
    );
  }

  let budget = { ...DEFAULT_BUDGET };
  if (present(top, "budget")) {
    const budgetFields = fields(top.budget, "contract.budget", [], ["max_turns", "max_tool_calls"]);
    budget = {
      max_turns: present(budgetFields, "max_turns")
        ? integer(budgetFields.max_turns, "contract.budget.max_turns", 1, Number.MAX_SAFE_INTEGER)
        : DEFAULT_BUDGET.max_turns,
      max_tool_calls: present(budgetFields, "max_tool_calls")
        ? integer(budgetFields.max_tool_calls, "contract.budget.max_tool_calls", 1, Number.MAX_SAFE_INTEGER)
        : DEFAULT_BUDGET.max_tool_calls,
    };
  }

  return deepFreeze({
    task,
    classification,
    success_criteria,
    grant: { scopes, ttl_seconds },
    commands,
    verification: {
      required_strength,
      protected: protectedGlobs,
      checks,
      must_fail,
    },
    ignore: present(top, "ignore") ? list(top.ignore, "contract.ignore", glob) : [...DEFAULT_IGNORE],
    budget,
  });
}
