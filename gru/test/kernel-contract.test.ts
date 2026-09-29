import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractError, parseContract } from "../src/contract.ts";

function minimal(): Record<string, unknown> {
  return {
    task: "Fix the failing parser test",
    classification: "MICRO",
    grant: { scopes: ["workspace:read"], ttl_seconds: 600 },
    commands: [],
    verification: { protected: ["test/**"], checks: [] },
  };
}

function withCommand(): Record<string, unknown> {
  return {
    ...minimal(),
    grant: { scopes: ["workspace:read", "command:build"], ttl_seconds: 600 },
    commands: [{ id: "build", argv: ["npm", "run", "build"], consequences: ["EXECUTE_WORKSPACE_CODE"], timeout_ms: 1000 }],
  };
}

describe("parseContract", () => {
  it("fills every documented default when fields are omitted", () => {
    const contract = parseContract(withCommand());
    assert.deepEqual(contract.success_criteria, []);
    assert.equal(contract.verification.required_strength, null);
    assert.deepEqual(contract.verification.must_fail, []);
    assert.deepEqual(contract.ignore, [".git/**", "node_modules/**"]);
    assert.deepEqual(contract.budget, { max_turns: 30, max_tool_calls: 100 });
    assert.deepEqual(contract.commands[0]!.env, {});
    assert.deepEqual(contract.commands[0]!.writes, []);
    assert.deepEqual(contract.commands[0]!.deletes, []);
  });

  it("fills check env and a partial budget", () => {
    const contract = parseContract({
      ...minimal(),
      verification: { protected: [], checks: [{ id: "unit", argv: ["node", "--test"], timeout_ms: 5000 }] },
      budget: { max_turns: 5 },
    });
    assert.deepEqual(contract.verification.checks[0]!.env, {});
    assert.deepEqual(contract.budget, { max_turns: 5, max_tool_calls: 100 });
  });

  it("returns a deep-frozen contract", () => {
    const contract = parseContract(withCommand());
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.verification.protected));
    assert.ok(Object.isFrozen(contract.commands[0]!.argv));
    assert.throws(() => (contract.verification.protected as string[]).push("x"));
  });

  it("rejects an unknown key at the top level and when nested", () => {
    assert.throws(() => parseContract({ ...minimal(), protect: ["test/**"] }), /contract\.protect is not a contract field/);
    assert.throws(
      () => parseContract({ ...minimal(), verification: { protected: [], checks: [], protectd: [] } }),
      /contract\.verification\.protectd is not a contract field/,
    );
    assert.throws(
      () =>
        parseContract({
          ...minimal(),
          verification: { protected: [], checks: [{ id: "a", argv: ["x"], timeout_ms: 1, shell: true }] },
        }),
      /shell is not a contract field/,
    );
  });

  it("rejects an empty task, a wrong type and a missing required field", () => {
    assert.throws(() => parseContract({ ...minimal(), task: "   " }), ContractError);
    assert.throws(() => parseContract({ ...minimal(), classification: "INFO" }), /classification/);
    assert.throws(() => parseContract({ ...minimal(), commands: "none" }), /must be an array/);
    const { verification: _omitted, ...rest } = minimal();
    assert.throws(() => parseContract(rest), /contract\.verification is required/);
  });

  it("lets a contract raise the floor but never lower it", () => {
    const raised = parseContract({
      ...minimal(),
      verification: { protected: [], checks: [], required_strength: "ADVERSARIAL" },
    });
    assert.equal(raised.verification.required_strength, "ADVERSARIAL");
    assert.throws(
      () =>
        parseContract({
          ...minimal(),
          classification: "MATERIAL",
          verification: { protected: [], checks: [], required_strength: "CHECKED" },
        }),
      /below the MATERIAL floor INDEPENDENT; a contract may raise the floor, never lower it/,
    );
    assert.throws(
      () => parseContract({ ...minimal(), verification: { protected: [], checks: [], required_strength: "ASSERTED" } }),
      /below the MICRO floor CHECKED/,
    );
  });

  it("rejects a malformed scope", () => {
    for (const scope of ["workspace:admin", "command:", "command:Build", "shell:*", "workspace:read "]) {
      assert.throws(
        () => parseContract({ ...minimal(), grant: { scopes: [scope], ttl_seconds: 60 } }),
        /is not a valid scope/,
        scope,
      );
    }
  });

  it("rejects a command scope for a command the contract does not declare", () => {
    assert.throws(
      () => parseContract({ ...minimal(), grant: { scopes: ["command:deploy"], ttl_seconds: 60 } }),
      /grants command:deploy, but no such command is declared/,
    );
  });

  it("rejects duplicate command and check ids", () => {
    const command = { id: "build", argv: ["make"], consequences: [], timeout_ms: 10 };
    assert.throws(() => parseContract({ ...minimal(), commands: [command, command] }), /duplicate id "build"/);
    const check = { id: "unit", argv: ["make", "test"], timeout_ms: 10 };
    assert.throws(
      () => parseContract({ ...minimal(), verification: { protected: [], checks: [check], must_fail: [check] } }),
      /duplicate id "unit"/,
    );
  });

  it("validates argv, consequences, timeouts, ttl, globs and env", () => {
    const base = { id: "build", argv: ["make"], consequences: [], timeout_ms: 10 };
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...base, argv: [] }, /must name a program/],
      [{ ...base, argv: ["make", ""] }, /non-empty string without NUL/],
      [{ ...base, argv: ["make\0x"] }, /non-empty string without NUL/],
      [{ ...base, consequences: ["DELETE_EVERYTHING"] }, /not a known consequence/],
      [{ ...base, timeout_ms: 0 }, /timeout_ms must be an integer from 1 to 600000/],
      [{ ...base, timeout_ms: 600_001 }, /timeout_ms/],
      [{ ...base, timeout_ms: 1.5 }, /timeout_ms/],
      [{ ...base, writes: [""] }, /non-empty glob/],
      [{ ...base, env: { "BAD-NAME": "x" } }, /not a valid environment variable name/],
      [{ ...base, env: { OK: 1 } }, /must be a string/],
      [{ ...base, id: "Build" }, /must match/],
    ];
    for (const [command, pattern] of bad) {
      assert.throws(() => parseContract({ ...minimal(), commands: [command] }), pattern, JSON.stringify(command));
    }
    assert.throws(() => parseContract({ ...minimal(), grant: { scopes: [], ttl_seconds: 0 } }), /ttl_seconds/);
    assert.throws(() => parseContract({ ...minimal(), grant: { scopes: [], ttl_seconds: 86_401 } }), /ttl_seconds/);
    assert.throws(() => parseContract({ ...minimal(), ignore: [""] }), /non-empty glob/);
  });
});
