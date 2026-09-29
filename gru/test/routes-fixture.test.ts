import assert from "node:assert/strict";
import { test } from "node:test";

import { FixtureError, FixtureRoute, loadFixture, type FixtureScript } from "../src/routes/fixture.ts";
import type { ToolResult } from "../src/types.ts";

const OPEN = { system: "sys", task: "do the thing", tools: [] };

const SCRIPT: FixtureScript = {
  turns: [
    { text: "reading", calls: [{ name: "read_file", input: { path: "a.txt" } }, { name: "list_dir", input: { path: "." } }] },
    { text: "writing", calls: [{ name: "write_file", input: { path: "b.txt", content: "x" } }], stop: "max_tokens" },
    { text: "done" },
  ],
};

test("fixture: turns come back in script order with fx-<turn>-<index> ids and default stops", async () => {
  const session = new FixtureRoute(SCRIPT).open(OPEN);

  const first = await session.next({ results: [] });
  assert.equal(first.text, "reading");
  assert.deepEqual(first.calls, [
    { id: "fx-0-0", name: "read_file", input: { path: "a.txt" } },
    { id: "fx-0-1", name: "list_dir", input: { path: "." } },
  ]);
  assert.equal(first.stop, "tool_use", "calls present -> tool_use by default");

  const second = await session.next({ results: [{ call_id: "fx-0-0", ok: true, content: "A" }] });
  assert.equal(second.calls[0]?.id, "fx-1-0");
  assert.equal(second.stop, "max_tokens", "an explicit stop is kept");

  const third = await session.next({ results: [] });
  assert.equal(third.text, "done");
  assert.deepEqual(third.calls, []);
  assert.equal(third.stop, "end_turn", "no calls -> end_turn by default");
  assert.equal(third.served_model, "scripted");
  assert.deepEqual(third.usage, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(third.detail, null);
});

test("fixture: after the script ends every turn is an empty end_turn", async () => {
  const session = new FixtureRoute({ turns: [{ text: "only" }] }).open(OPEN);
  await session.next({ results: [] });
  for (let index = 0; index < 3; index += 1) {
    const turn = await session.next({ results: [] });
    assert.deepEqual(
      { text: turn.text, calls: turn.calls, stop: turn.stop, served_model: turn.served_model },
      { text: "", calls: [], stop: "end_turn", served_model: "scripted" },
    );
  }
});

test("fixture: the default descriptor names the scripted fixture and no credential", () => {
  assert.deepEqual(new FixtureRoute({ turns: [] }).descriptor, {
    id: "fixture/scripted",
    kind: "fixture",
    provider: "fixture",
    model: "scripted",
    base_url: null,
    credential_ref: null,
  });
});

test("fixture: served_model stays 'scripted' even under a custom descriptor", async () => {
  const route = new FixtureRoute(SCRIPT, {
    id: "x/y",
    kind: "fixture",
    provider: "x",
    model: "y",
    base_url: null,
    credential_ref: null,
  });
  assert.equal(route.descriptor.id, "x/y");
  assert.equal((await route.open(OPEN).next({ results: [] })).served_model, "scripted");
});

test("fixture: every received input is recorded as a copy", async () => {
  const route = new FixtureRoute(SCRIPT);
  const session = route.open(OPEN);
  const results: ToolResult[] = [
    { call_id: "fx-0-0", ok: true, content: "file A" },
    { call_id: "fx-0-1", ok: false, content: "denied: path escape" },
  ];
  await session.next({ results: [] });
  await session.next({ results });
  await session.next({ results: [], user: "keep going" });
  results[0]!.content = "mutated after the fact";

  assert.deepEqual(session.received, [
    { results: [] },
    {
      results: [
        { call_id: "fx-0-0", ok: true, content: "file A" },
        { call_id: "fx-0-1", ok: false, content: "denied: path escape" },
      ],
    },
    { results: [], user: "keep going" },
  ]);
  assert.equal(route.sessions.length, 1);
  assert.equal(route.sessions[0], session);
  assert.deepEqual(session.opened, { system: "sys", task: "do the thing", tools: [] });
});

test("fixture: each open() replays the script from the start", async () => {
  const route = new FixtureRoute(SCRIPT);
  await route.open(OPEN).next({ results: [] });
  const again = await route.open(OPEN).next({ results: [] });
  assert.equal(again.text, "reading");
  assert.equal(route.sessions.length, 2);
});

test("fixture: the route copies its script; later mutation of the source changes nothing", async () => {
  const script: FixtureScript = { turns: [{ text: "original", calls: [{ name: "read_file", input: { path: "a" } }] }] };
  const route = new FixtureRoute(script);
  script.turns[0]!.text = "changed";
  (script.turns[0]!.calls![0]!.input as { path: string }).path = "changed";
  const turn = await route.open(OPEN).next({ results: [] });
  assert.equal(turn.text, "original");
  assert.deepEqual(turn.calls[0]?.input, { path: "a" });
});

test("fixture: returned call inputs are copies; mutating one does not alter a replay", async () => {
  const route = new FixtureRoute(SCRIPT);
  const turn = await route.open(OPEN).next({ results: [] });
  (turn.calls[0]!.input as { path: string }).path = "../../etc/passwd";
  const replay = await route.open(OPEN).next({ results: [] });
  assert.deepEqual(replay.calls[0]?.input, { path: "a.txt" });
});

test("fixture: loadFixture accepts deliberately malformed tool input (for AVL to reject)", () => {
  const script = loadFixture({ turns: [{ calls: [{ name: "write_file", input: "not an object" }] }] });
  assert.equal(script.turns[0]?.calls?.[0]?.input, "not an object");
});

test("fixture: loadFixture rejects malformed scripts", () => {
  const bad: [unknown, RegExp][] = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{}, /turns: must be an array/],
    [{ turns: [], extra: 1 }, /unknown key "extra"/],
    [{ turns: [1] }, /turns\[0\]: must be an object/],
    [{ turns: [{ text: 5 }] }, /text: must be a string/],
    [{ turns: [{ say: "hi" }] }, /unknown key "say"/],
    [{ turns: [{ calls: {} }] }, /calls: must be an array/],
    [{ turns: [{ calls: [{ input: {} }] }] }, /name: must be a non-empty string/],
    [{ turns: [{ calls: [{ name: "", input: {} }] }] }, /name: must be a non-empty string/],
    [{ turns: [{ calls: [{ name: "read_file" }] }] }, /input: required/],
    [{ turns: [{ calls: [{ name: "read_file", input: {}, id: "x" }] }] }, /unknown key "id"/],
    [{ turns: [{ stop: "pause_turn" }] }, /stop: must be one of/],
  ];
  for (const [json, pattern] of bad) {
    assert.throws(() => loadFixture(json), (error: unknown) => error instanceof FixtureError && pattern.test(error.message), JSON.stringify(json));
  }
});

test("fixture: the constructor validates too", () => {
  assert.throws(() => new FixtureRoute({ turns: [{ stop: "bogus" }] } as unknown as FixtureScript), FixtureError);
});
