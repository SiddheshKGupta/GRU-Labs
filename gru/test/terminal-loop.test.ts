import { test } from "node:test";
import assert from "node:assert/strict";
import { runMinion, type MinionEvent } from "../src/minion/loop.ts";
import { RouteError } from "../src/types.ts";
import { FakeRoute, FakeSession, call, contract, turn } from "./terminal-fake-blocks.ts";

test("a refusal ends the loop as REFUSED and none of that turn's calls run", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ stop: "refusal", calls: [call("c1")], detail: "policy" })]);
  const run = await runMinion({ session, route });
  assert.equal(run.outcome, "REFUSED");
  assert.equal(session.handled.length, 0);
  assert.equal(session.turns.length, 1, "the refusal turn is still recorded");
});

test("max_tokens with tool calls ends as TRUNCATED and runs none of them", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ stop: "max_tokens", calls: [call("c1"), call("c2")] })]);
  const run = await runMinion({ session, route });
  assert.equal(run.outcome, "TRUNCATED");
  assert.equal(session.handled.length, 0);
});

test("an unrecognised stop reason ends as TRUNCATED and runs nothing", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ stop: "other", calls: [call("c1")] })]);
  const run = await runMinion({ session, route });
  assert.equal(run.outcome, "TRUNCATED");
  assert.equal(session.handled.length, 0);
});

test("the tool budget stops the loop after exactly max_tool_calls calls", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([
    turn({ calls: [call("a"), call("b")] }),
    turn({ calls: [call("c"), call("d")] }),
    turn({ text: "never reached" }),
  ]);
  const run = await runMinion({ session, route, budget: { max_turns: 10, max_tool_calls: 3 } });
  assert.equal(run.outcome, "BUDGET_EXHAUSTED");
  assert.deepEqual(session.handled.map((c) => c.id), ["a", "b", "c"]);
  assert.equal(run.tool_calls, 3);
});

test("the turn budget stops the loop and the last allowed turn's calls do not run", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ calls: [call("a")] }), turn({ calls: [call("b")] }), turn({ calls: [call("c")] })]);
  const run = await runMinion({ session, route, budget: { max_turns: 2, max_tool_calls: 100 } });
  assert.equal(run.outcome, "BUDGET_EXHAUSTED");
  assert.equal(run.turns, 2);
  assert.deepEqual(session.handled.map((c) => c.id), ["a"]);
  assert.equal(route.inputs.length, 2, "no third turn is requested");
});

test("budget defaults to the contract's budget", async () => {
  const session = new FakeSession({ contract: contract({ budget: { max_turns: 50, max_tool_calls: 1 } }) });
  const route = new FakeRoute([turn({ calls: [call("a"), call("b")] })]);
  const run = await runMinion({ session, route });
  assert.equal(run.outcome, "BUDGET_EXHAUSTED");
  assert.deepEqual(session.handled.map((c) => c.id), ["a"]);
});

test("a RouteError from next() ends as ROUTE_ERROR with an error event", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ calls: [call("a")] }), new RouteError("overloaded", { retryable: true, status: 529 })]);
  const events: MinionEvent[] = [];
  // Retries are covered in loop-robustness.test.ts; here the first failure is final.
  const run = await runMinion({ session, route, onEvent: (event) => events.push(event), retry: { attempts: 0, base_ms: 0, max_ms: 0 } });
  assert.equal(run.outcome, "ROUTE_ERROR");
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.status, 529);
  assert.equal(error.retryable, true);
});

test("any error thrown by the route, including from open(), is ROUTE_ERROR", async () => {
  const first = await runMinion({ session: new FakeSession(), route: new FakeRoute([new TypeError("socket hang up")]) });
  assert.equal(first.outcome, "ROUTE_ERROR");
  const opened = await runMinion({
    session: new FakeSession(),
    route: new FakeRoute([], { openError: new Error("no credential") }),
  });
  assert.equal(opened.outcome, "ROUTE_ERROR");
  assert.equal(opened.turns, 0);
});

test("calls are handled in order and their results go back to the route in order", async () => {
  const session = new FakeSession({ handle: (c) => ({ call_id: c.id, ok: c.id !== "b", content: `out:${c.id}` }) });
  const route = new FakeRoute([turn({ calls: [call("a"), call("b"), call("c")] }), turn({ text: "done" })]);
  const events: MinionEvent[] = [];
  await runMinion({ session, route, onEvent: (event) => events.push(event) });
  assert.deepEqual(session.handled.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(route.inputs[0], { results: [] }, "the first request carries no results");
  assert.deepEqual(
    route.inputs[1]?.results.map((r) => [r.call_id, r.ok, r.content]),
    [["a", true, "out:a"], ["b", false, "out:b"], ["c", true, "out:c"]],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "call").map((e) => (e.type === "call" ? e.call.id : "")),
    ["a", "b", "c"],
  );
});

test("a turn with no calls ends as COMPLETED, whatever the text claims", async () => {
  const session = new FakeSession();
  const route = new FakeRoute([turn({ calls: [call("a")] }), turn({ text: "Everything is broken, I give up.", stop: "end_turn" })]);
  const run = await runMinion({ session, route });
  assert.equal(run.outcome, "COMPLETED");
  assert.equal(run.turns, 2);
  assert.equal(run.tool_calls, 1);
});

test("every turn is recorded with the session before anything else happens", async () => {
  const log: string[] = [];
  const session = new FakeSession({ log });
  const route = new FakeRoute([turn({ calls: [call("a")] }), turn({ text: "done" })], { log });
  await runMinion({ session, route });
  assert.deepEqual(log, ["route.open", "route.next", "session.recordTurn", "session.handle:a", "route.next", "session.recordTurn"]);
});

test("the loop never closes the session, whatever the outcome", async () => {
  for (const script of [
    [turn({ text: "done" })],
    [turn({ stop: "refusal" })],
    [new RouteError("x", { retryable: false, status: 500 })],
    [turn({ calls: [call("a")] }), turn({ calls: [call("b")] })],
  ]) {
    const session = new FakeSession();
    await runMinion({ session, route: new FakeRoute(script), budget: { max_turns: 2, max_tool_calls: 5 } });
    assert.deepEqual(session.closed, []);
  }
});

test("the route receives the governed system prompt, the contract task and the session's tools", async () => {
  const session = new FakeSession({ contract: contract({ task: "Fix the parser." }) });
  const route = new FakeRoute([turn({ text: "done" })]);
  await runMinion({ session, route });
  assert.equal(route.opened[0]?.task, "Fix the parser.");
  assert.match(route.opened[0]?.system ?? "", /GRU Minion/);
  assert.equal(route.opened[0]?.tools, session.tools);
});

test("an error thrown by the session is not disguised as a route error", async () => {
  const session = new FakeSession({
    handle: () => {
      throw new Error("kernel bug");
    },
  });
  const route = new FakeRoute([turn({ calls: [call("a")] })]);
  const events: MinionEvent[] = [];
  const run = await runMinion({ session, route, onEvent: (event) => events.push(event) });
  assert.equal(run.outcome, "KERNEL_ERROR");
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error" && error.source === "kernel" && /kernel bug/.test(error.message));
});
