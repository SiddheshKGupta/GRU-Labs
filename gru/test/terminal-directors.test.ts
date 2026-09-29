import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  DenyAllDirector,
  DirectorScriptError,
  InteractiveDirector,
  LineInput,
  ScriptedDirector,
  loadDirectorScript,
} from "../src/director/channels.ts";
import { escalationRequest } from "./terminal-fake-blocks.ts";

// ---------------------------------------------------------------- deny-all

test("DenyAllDirector rejects as AVL and says escalations fail closed", async () => {
  const decision = await new DenyAllDirector().decide(escalationRequest());
  assert.deepEqual(decision, {
    decision: "REJECT",
    actor: "avl:v0",
    reason: "no Director channel attached; escalations fail closed",
  });
});

// ---------------------------------------------------------------- scripted

test("ScriptedDirector: the first matching rule wins", async () => {
  const director = new ScriptedDirector([
    { match: { tool: "write_file", path: "src/**" }, decision: "APPROVE", reason: "source edits are fine" },
    { match: { tool: "write_file" }, decision: "REJECT", reason: "only src/" },
    { match: {}, decision: "APPROVE", reason: "catch-all" },
  ]);
  const write = (path: string) =>
    escalationRequest({
      tool: "write_file",
      effect: { kind: "fs.write", path, content_sha256: "0".repeat(64), bytes: 1 },
      consequences: ["MODIFY_WORKSPACE"],
    });
  assert.deepEqual(await director.decide(write("src/a/b.js")), {
    decision: "APPROVE",
    actor: "director:scripted",
    reason: "source edits are fine",
  });
  assert.equal((await director.decide(write("docs/x.md"))).reason, "only src/");
  assert.equal((await director.decide(escalationRequest({ tool: "delete_file" }))).reason, "catch-all");
});

test("ScriptedDirector: consequence matching and default REJECT when nothing matches", async () => {
  const director = new ScriptedDirector([
    { match: { consequence: "ALTER_VERIFICATION" }, decision: "REJECT", reason: "tests are the contract" },
    { match: { consequence: "EXTERNAL_SIDE_EFFECT" }, decision: "APPROVE", reason: "ok" },
  ]);
  assert.equal((await director.decide(escalationRequest())).reason, "tests are the contract");
  const unmatched = await director.decide(
    escalationRequest({ tool: "run_command", effect: { kind: "process.run", command_id: "x" }, consequences: ["MUTATE_REPOSITORY"] }),
  );
  assert.deepEqual(unmatched, { decision: "REJECT", actor: "director:scripted", reason: "no scripted rule matched" });
});

test("ScriptedDirector: a path rule never matches an effect without a path", async () => {
  const director = new ScriptedDirector([{ match: { path: "**" }, decision: "APPROVE", reason: "any path" }]);
  const decision = await director.decide(
    escalationRequest({ tool: "run_command", effect: { kind: "process.run", command_id: "build" }, consequences: ["MUTATE_REPOSITORY"] }),
  );
  assert.equal(decision.decision, "REJECT");
});

test("ScriptedDirector: rules cannot be changed after construction", async () => {
  const rules = [{ match: {}, decision: "REJECT" as const, reason: "no" }];
  const director = new ScriptedDirector(rules);
  (rules[0] as { decision: string }).decision = "APPROVE";
  assert.equal((await director.decide(escalationRequest())).decision, "REJECT");
});

test("loadDirectorScript validates strictly", () => {
  const good = loadDirectorScript({
    description: "demo",
    rules: [{ match: { consequence: "ALTER_VERIFICATION" }, decision: "REJECT", reason: "no" }],
  });
  assert.equal(good.length, 1);
  const bad: unknown[] = [
    [],
    { rules: {} },
    { rules: [], extra: 1 },
    { rules: [{ match: {}, decision: "MAYBE", reason: "x" }] },
    { rules: [{ match: { consequence: "DELETE_EVERYTHING" }, decision: "REJECT", reason: "x" }] },
    { rules: [{ match: { command: "x" }, decision: "REJECT", reason: "x" }] },
    { rules: [{ match: {}, decision: "REJECT", reason: "" }] },
    { rules: [{ match: {}, decision: "REJECT" }] },
    { rules: [{ decision: "REJECT", reason: "x" }] },
  ];
  for (const script of bad) assert.throws(() => loadDirectorScript(script), DirectorScriptError, JSON.stringify(script));
});

// ---------------------------------------------------------------- interactive

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  const waiters: { text: string; count: number; resolve: () => void }[] = [];
  const occurrences = (text: string) => written.split(text).length - 1;
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
    for (const waiter of [...waiters]) {
      if (occurrences(waiter.text) >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  const waitFor = (text: string, count = 1) =>
    occurrences(text) >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ text, count, resolve }));
  return { input, output, text: () => written, waitFor };
}

async function answer(lines: string[]): Promise<{ decision: Awaited<ReturnType<InteractiveDirector["decide"]>>; text: string }> {
  const s = streams();
  const director = new InteractiveDirector({ input: s.input, output: s.output });
  const pending = director.decide(escalationRequest());
  await s.waitFor("Approve? [y/N]");
  s.input.write(`${lines[0]}\n`);
  if (lines.length > 1) {
    await s.waitFor("Reason:");
    s.input.write(`${lines[1]}\n`);
  }
  const decision = await pending;
  director.close();
  return { decision, text: s.text() };
}

test("InteractiveDirector prints a card with the tool, effect, consequences and AVL's reasons", async () => {
  const { text } = await answer(["n", ""]);
  assert.match(text, /Director approval needed/);
  assert.match(text, /delete_file/);
  assert.match(text, /fs\.delete test\/slugify\.test\.js/);
  assert.match(text, /DESTROY_WORKSPACE_DATA, ALTER_VERIFICATION/);
  assert.match(text, /ALTER_VERIFICATION always requires Project Director approval/);
});

for (const yes of ["y", "yes", "Y", " YES "]) {
  test(`InteractiveDirector approves on ${JSON.stringify(yes)}`, async () => {
    const { decision } = await answer([yes, "looks right"]);
    assert.deepEqual(decision, { decision: "APPROVE", actor: "director:terminal", reason: "looks right" });
  });
}

for (const no of ["", "n", "no", "yep", "sure", "ok", "yes please"]) {
  test(`InteractiveDirector rejects on ${JSON.stringify(no)}`, async () => {
    const { decision } = await answer([no, ""]);
    assert.equal(decision.decision, "REJECT");
    assert.equal(decision.actor, "director:terminal");
  });
}

test("InteractiveDirector rejects at end of input", async () => {
  const s = streams();
  const director = new InteractiveDirector({ input: s.input, output: s.output });
  const pending = director.decide(escalationRequest());
  await s.waitFor("Approve? [y/N]");
  s.input.end();
  const decision = await pending;
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.reason, /input ended/);
});

test("InteractiveDirector rejects when input ends after a yes but before the reason", async () => {
  const s = streams();
  const director = new InteractiveDirector({ input: s.input, output: s.output });
  const pending = director.decide(escalationRequest());
  await s.waitFor("Approve? [y/N]");
  s.input.write("y\n");
  await s.waitFor("Reason:");
  s.input.end();
  assert.equal((await pending).decision, "REJECT");
});

test("InteractiveDirector ignores answers typed before the card was shown", async () => {
  const s = streams();
  const director = new InteractiveDirector({ input: s.input, output: s.output });
  s.input.write("y\ntrust me\n");
  await new Promise((resolve) => setImmediate(resolve));
  const pending = director.decide(escalationRequest());
  await s.waitFor("Approve? [y/N]");
  s.input.write("\n");
  await s.waitFor("Reason:");
  s.input.write("\n");
  assert.equal((await pending).decision, "REJECT");
  director.close();
});

test("InteractiveDirector escapes control characters in model-supplied paths", async () => {
  const s = streams();
  const director = new InteractiveDirector({ input: s.input, output: s.output });
  const pending = director.decide(
    escalationRequest({ effect: { kind: "fs.delete", path: "a\u001b[2K\rAPPROVED by director\nb" } }),
  );
  await s.waitFor("Approve? [y/N]");
  s.input.end();
  await pending;
  assert.ok(!s.text().includes("\u001b[2K"), "raw escape sequence reached the terminal");
  assert.match(s.text(), /a\\x1b\[2K\\rAPPROVED by director\\nb/);
});

test("InteractiveDirector shares a LineInput without closing it, one question at a time", async () => {
  const s = streams();
  const lines = new LineInput(s.input, s.output, { terminal: false });
  const director = new InteractiveDirector({ input: lines, output: s.output });
  const first = director.decide(escalationRequest({ authorization_id: "auth-1" }));
  const second = director.decide(escalationRequest({ authorization_id: "auth-2" }));
  await s.waitFor("Approve? [y/N]", 1);
  s.input.write("y\n");
  await s.waitFor("Reason:", 1);
  s.input.write("first\n");
  assert.equal((await first).decision, "APPROVE");
  await s.waitFor("Approve? [y/N]", 2);
  s.input.write("n\n");
  await s.waitFor("Reason:", 2);
  s.input.write("second\n");
  assert.deepEqual(await second, { decision: "REJECT", actor: "director:terminal", reason: "second" });
  director.close();
  assert.equal(lines.closed, false, "a shared LineInput belongs to its owner");
  s.input.write("still here\n");
  assert.equal(await lines.ask("> "), "still here");
  lines.close();
});
