import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, sha256 } from "../src/ledger/canonical.ts";
import { mapHostTool, type HostMapContext, type HostMapping } from "../src/hooks/host-map.ts";

const ctx: HostMapContext = {
  workspaceRoot: "/root",
  declaredCommands: [
    { id: "test", argv: ["npm", "test"] },
    { id: "lint", argv: ["npx", "eslint", "."] },
    { id: "odd", argv: ["FOO=1", "run"] },
  ],
};

const claude = (tool: string, input: unknown, context: HostMapContext = ctx): HostMapping =>
  mapHostTool("claude-code", tool, input, context);

const other = (tool: string, input: unknown): HostMapping => ({
  kind: "effect",
  effect: { kind: "host.other", tool, input_sha256: sha256(canonical(input)) },
});

const exec = (command: string): HostMapping => ({ kind: "effect", effect: { kind: "host.exec", tool: "Bash", command } });

test("host-map: Bash equal to a declared argv -> process.run of that command", () => {
  assert.deepEqual(claude("Bash", { command: "npm test" }), { kind: "effect", effect: { kind: "process.run", command_id: "test" } });
  assert.deepEqual(claude("Bash", { command: "  npx   eslint . ", description: "lint" }), {
    kind: "effect",
    effect: { kind: "process.run", command_id: "lint" },
  });
});

test("host-map: Bash that is not exactly a declared argv -> host.exec", () => {
  for (const command of ["npm test --watch", "npm", "npm tests", "rm -rf build"]) {
    assert.deepEqual(claude("Bash", { command }), exec(command), command);
  }
});

test("host-map: Bash with any shell metacharacter class -> host.exec, never process.run", () => {
  const classes = [";", "|", "&", "$", "`", ">", "<", "(", ")", "{", "}", "*", "?", "!", "\\", "\n", "'", '"', "[", "]", "~", "#", "\r"];
  for (const meta of classes) {
    // The metacharacter check is what matters when the Director declared an
    // argv word that contains one: a shell would expand it, an argv executor would not.
    const word = `a${meta}b`;
    const withMeta: HostMapContext = { ...ctx, declaredCommands: [{ id: "m", argv: ["run", word] }] };
    const command = `run ${word}`;
    assert.deepEqual(claude("Bash", { command }, withMeta), exec(command), JSON.stringify(command));
    for (const variant of [`npm test${meta}`, `npm te${meta}st`, `${meta}npm test`]) {
      assert.deepEqual(claude("Bash", { command: variant }), exec(variant), JSON.stringify(variant));
    }
  }
  // Control: the same shape without a metacharacter does map.
  const plain: HostMapContext = { ...ctx, declaredCommands: [{ id: "m", argv: ["run", "a-b"] }] };
  assert.deepEqual(claude("Bash", { command: "run a-b" }, plain), { kind: "effect", effect: { kind: "process.run", command_id: "m" } });
});

test("host-map: a leading NAME=value word is a shell assignment, not a program -> host.exec", () => {
  assert.deepEqual(claude("Bash", { command: "FOO=1 run" }), exec("FOO=1 run"));
});

test("host-map: a declared command run from another directory -> host.exec", () => {
  assert.deepEqual(claude("Bash", { command: "npm test" }, { ...ctx, cwd: "/root/sub" }), exec("npm test"));
  assert.deepEqual(claude("Bash", { command: "npm test" }, { ...ctx, cwd: "/root/" }), {
    kind: "effect",
    effect: { kind: "process.run", command_id: "test" },
  });
});

test("host-map: Read inside the root -> fs.read of the workspace-relative path", () => {
  assert.deepEqual(claude("Read", { file_path: "/root/src/a.ts" }), { kind: "effect", effect: { kind: "fs.read", path: "src/a.ts" } });
  assert.deepEqual(claude("Read", { file_path: "/root/src/../b.ts", limit: 10 }), {
    kind: "effect",
    effect: { kind: "fs.read", path: "b.ts" },
  });
  assert.deepEqual(claude("Read", { file_path: "a.ts" }, { ...ctx, cwd: "/root/src" }), {
    kind: "effect",
    effect: { kind: "fs.read", path: "src/a.ts" },
  });
});

test("host-map: Read outside the root, including a sibling prefix, -> host.other", () => {
  for (const file_path of ["/etc/passwd", "/root-evil/x", "/root/../root-evil/x", "/rootx", "/"]) {
    const input = { file_path };
    assert.deepEqual(claude("Read", input), other("Read", input), file_path);
  }
  const relativeEscape = { file_path: "../../etc/passwd" };
  assert.deepEqual(claude("Read", relativeEscape, { ...ctx, cwd: "/root/src" }), other("Read", relativeEscape));
});

test("host-map: malformed input for a known tool -> host.other", () => {
  for (const input of [{}, { file_path: 7 }, { file_path: "" }, "Read /root/a", null]) {
    assert.deepEqual(claude("Read", input), other("Read", input));
  }
  assert.deepEqual(claude("Write", { file_path: "/root/a" }), other("Write", { file_path: "/root/a" }));
});

test("host-map: Write hashes the content and counts UTF-8 bytes", () => {
  assert.deepEqual(claude("Write", { file_path: "/root/a.txt", content: "hello" }), {
    kind: "effect",
    effect: { kind: "fs.write", path: "a.txt", content_sha256: sha256("hello"), bytes: 5 },
  });
  const mapped = claude("Write", { file_path: "/root/b.txt", content: "é" });
  assert.equal(mapped.kind === "effect" && mapped.effect.kind === "fs.write" ? mapped.effect.bytes : -1, 2);
});

test("host-map: Edit, MultiEdit and NotebookEdit are writes flagged as content-unknown", () => {
  const edit = { file_path: "/root/a.ts", old_string: "a", new_string: "b" };
  assert.deepEqual(claude("Edit", edit), {
    kind: "effect",
    effect: { kind: "fs.write", path: "a.ts", content_sha256: sha256(canonical(edit)), bytes: 0 },
  });
  const multi = { file_path: "/root/test/x.test.ts", edits: [{ old_string: "a", new_string: "b" }] };
  assert.deepEqual(claude("MultiEdit", multi), {
    kind: "effect",
    effect: { kind: "fs.write", path: "test/x.test.ts", content_sha256: sha256(canonical(multi)), bytes: 0 },
  });
  const notebook = { notebook_path: "/root/n.ipynb", new_source: "print(1)" };
  assert.deepEqual(claude("NotebookEdit", notebook), {
    kind: "effect",
    effect: { kind: "fs.write", path: "n.ipynb", content_sha256: sha256(canonical(notebook)), bytes: 0 },
  });
  const outside = { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" };
  assert.deepEqual(claude("Edit", outside), other("Edit", outside));
});

test("host-map: Glob, Grep and LS -> fs.list of the search root; an escaping pattern -> host.other", () => {
  assert.deepEqual(claude("Glob", { pattern: "**/*.ts" }), { kind: "effect", effect: { kind: "fs.list", path: "." } });
  assert.deepEqual(claude("Grep", { pattern: "TODO", path: "/root/src" }), { kind: "effect", effect: { kind: "fs.list", path: "src" } });
  assert.deepEqual(claude("LS", { path: "/root" }), { kind: "effect", effect: { kind: "fs.list", path: "." } });
  for (const pattern of ["../*", "/etc/*", "src/../../x", "~/.ssh/*"]) {
    assert.deepEqual(claude("Glob", { pattern }), other("Glob", { pattern }), pattern);
  }
  assert.deepEqual(claude("Grep", { pattern: "x", path: "/home" }), other("Grep", { pattern: "x", path: "/home" }));
});

test("host-map: WebFetch and WebSearch -> host.fetch", () => {
  assert.deepEqual(claude("WebFetch", { url: "https://example.com", prompt: "p" }), {
    kind: "effect",
    effect: { kind: "host.fetch", tool: "WebFetch", url: "https://example.com" },
  });
  assert.deepEqual(claude("WebSearch", { query: "node net" }), {
    kind: "effect",
    effect: { kind: "host.fetch", tool: "WebSearch", url: "node net" },
  });
});

test("host-map: GRU's own MCP tools and TodoWrite pass through", () => {
  assert.equal(claude("mcp__gru__gru_write_file", { path: "a", content: "" }).kind, "passthrough");
  assert.equal(claude("TodoWrite", { todos: [] }).kind, "passthrough");
});

test("host-map: any other tool -> host.other with the canonical input digest", () => {
  for (const [tool, input] of [
    ["mcp__github__create_pull_request", { title: "x" }],
    ["mcp__gru_evil__x", {}],
    ["Task", { prompt: "do it" }],
    ["Frobnicate", undefined],
  ] as const) {
    assert.deepEqual(claude(tool, input), other(tool, input ?? null), tool);
  }
});

test("host-map: Codex maps every tool to host.other (no evidenced tool names)", () => {
  const input = { command: ["bash", "-lc", "npm test"] };
  assert.deepEqual(mapHostTool("codex", "shell", input, ctx), other("shell", input));
  assert.deepEqual(mapHostTool("codex", "mcp__gru__gru_status", {}, ctx), other("mcp__gru__gru_status", {}));
});

test("host-map: a relative workspace root is a configuration error", () => {
  assert.throws(() => claude("Read", { file_path: "/root/a" }, { ...ctx, workspaceRoot: "root" }), /absolute/);
});
