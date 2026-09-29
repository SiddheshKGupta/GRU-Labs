// A live route fails in ways a fixture never does: rate limits, and a
// kernel that throws. The loop retries what the route marks retryable, a
// bounded number of times, and turns a kernel failure into an outcome the
// episode can still close on.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideClosure } from "../src/avl/closure.ts";
import { runMinion, type MinionEvent } from "../src/minion/loop.ts";
import { RouteError, type ModelRoute, type ModelTurn, type ToolCall } from "../src/types.ts";

const done: ModelTurn = { text: "done", calls: [], stop: "end_turn" } as unknown as ModelTurn;
const call: ToolCall = { id: "c-1", name: "list_dir", input: { path: "." } } as unknown as ToolCall;
const withCall: ModelTurn = { text: "", calls: [call], stop: "tool_use" } as unknown as ModelTurn;

function route(script: (index: number) => ModelTurn): ModelRoute {
  let index = 0;
  return {
    descriptor: { id: "test/route" },
    open: () => ({ next: async () => script(index++) }),
  } as unknown as ModelRoute;
}

function session(handle: (call: ToolCall) => Promise<unknown> = async () => ({ call_id: "c-1", ok: true, content: "" })) {
  return {
    contract: { task: "t", budget: { max_turns: 10, max_tool_calls: 10 }, commands: [], success_criteria: [], verification: { protected: [], checks: [], must_fail: [] } },
    tools: [],
    handle,
    recordTurn: () => {},
  } as unknown as Parameters<typeof runMinion>[0]["session"];
}

const rateLimited = () => new RouteError("429 rate limited", { retryable: true, status: 429 });

test("a retryable failure is retried with exponential backoff, then the episode continues", async () => {
  const delays: number[] = [];
  const events: MinionEvent[] = [];
  const run = await runMinion({
    session: session(),
    route: route((i) => {
      if (i < 2) throw rateLimited();
      return done;
    }),
    sleep: async (ms) => void delays.push(ms),
    onEvent: (event) => events.push(event),
  });
  assert.equal(run.outcome, "COMPLETED");
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(events.filter((e) => e.type === "retry").length, 2);
});

test("retries are bounded: after the last one the loop ends ROUTE_ERROR", async () => {
  const delays: number[] = [];
  const run = await runMinion({
    session: session(),
    route: route(() => {
      throw rateLimited();
    }),
    retry: { attempts: 2, base_ms: 10, max_ms: 15 },
    sleep: async (ms) => void delays.push(ms),
  });
  assert.equal(run.outcome, "ROUTE_ERROR");
  assert.deepEqual(delays, [10, 15]);
});

test("a non-retryable failure is not retried", async () => {
  const delays: number[] = [];
  const run = await runMinion({
    session: session(),
    route: route(() => {
      throw new RouteError("401 bad key", { retryable: false, status: 401 });
    }),
    sleep: async (ms) => void delays.push(ms),
  });
  assert.equal(run.outcome, "ROUTE_ERROR");
  assert.deepEqual(delays, []);
});

test("a kernel error mid-loop ends KERNEL_ERROR instead of escaping, and closes ABANDONED", async () => {
  const run = await runMinion({
    session: session(async () => {
      throw new Error("disk full");
    }),
    route: route((i) => (i === 0 ? withCall : done)),
  });
  assert.equal(run.outcome, "KERNEL_ERROR");
  const closure = decideClosure({
    loop: run.outcome,
    verification: { outcome: "NOT_RUN", strength: "NONE", required: "INDEPENDENT", checks: [], must_fail: [] },
    violations: [],
  } as unknown as Parameters<typeof decideClosure>[0]);
  assert.equal(closure.status, "ABANDONED");
});
