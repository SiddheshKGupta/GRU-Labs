import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeCodeConfig,
  codexConfig,
  InstallError,
  mergeCodexToml,
  mergeHooks,
  mergeMcpServers,
  type InstallPaths,
} from "../src/install/hosts.ts";

const paths: InstallPaths = {
  cliPath: "/opt/gru/src/cli.ts",
  contractPath: "/work/contract.json",
  workspace: "/work/project",
  stateDir: "/home/u/.gru/state",
};

const hook = (event: string, host = "claude-code") => ({
  type: "command",
  command: `node "/opt/gru/src/cli.ts" hook ${host} ${event} --state "/home/u/.gru/state"`,
  timeout: 15,
});

test("install: Claude Code config has the MCP server and Pre/Post/SessionStart hooks", () => {
  assert.deepEqual(claudeCodeConfig(paths), {
    mcp: {
      mcpServers: {
        gru: {
          command: "node",
          args: [
            "/opt/gru/src/cli.ts",
            "mcp",
            "--contract",
            "/work/contract.json",
            "--workspace",
            "/work/project",
            "--state",
            "/home/u/.gru/state",
          ],
        },
      },
    },
    settings: {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [hook("PreToolUse")] }],
        PostToolUse: [{ matcher: "*", hooks: [hook("PostToolUse")] }],
        SessionStart: [{ hooks: [hook("SessionStart")] }],
      },
    },
  });
});

test("install: paths must be absolute and safe inside a double-quoted hook command", () => {
  assert.throws(() => claudeCodeConfig({ ...paths, stateDir: "state" }), InstallError);
  for (const bad of ['/a"b', "/a$(id)", "/a`id`", "/a\\b", "/a\nb"]) {
    assert.throws(() => claudeCodeConfig({ ...paths, cliPath: bad }), InstallError, JSON.stringify(bad));
    assert.throws(() => codexConfig({ ...paths, stateDir: bad }), InstallError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => claudeCodeConfig({ ...paths, workspace: "/work/my project" }));
});

test("install: Codex config is an MCP server entry plus a SessionStart hook only", () => {
  const config = codexConfig(paths);
  assert.match(config.configTomlSnippet, /^\[mcp_servers\.gru\]$/m);
  assert.match(config.configTomlSnippet, /^command = "node"$/m);
  assert.match(
    config.configTomlSnippet,
    /^args = \["\/opt\/gru\/src\/cli\.ts", "mcp", "--contract", "\/work\/contract\.json", "--workspace", "\/work\/project", "--state", "\/home\/u\/\.gru\/state"\]$/m,
  );
  assert.match(config.configTomlSnippet, /^tool_timeout_sec = 600$/m);
  assert.deepEqual(config.hooks, { hooks: { SessionStart: [{ hooks: [hook("SessionStart", "codex")] }] } });
});

test("mergeHooks: an absent file becomes the GRU hooks", () => {
  const additions = claudeCodeConfig(paths).settings;
  assert.deepEqual(mergeHooks(undefined, additions), { merged: additions, conflicts: [] });
});

test("mergeHooks: existing entries are preserved and GRU's are appended, without mutating the input", () => {
  const user = { type: "command", command: "python audit.py", timeout: 5 };
  const existing = {
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [user] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const snapshot = structuredClone(existing);
  const { merged, conflicts } = mergeHooks(existing, claudeCodeConfig(paths).settings);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(existing, snapshot, "input not mutated");
  const out = merged as typeof existing & { hooks: Record<string, unknown[]> };
  assert.equal(out.model, "opus");
  assert.deepEqual(out.hooks.PreToolUse, [{ matcher: "Bash", hooks: [user] }, { matcher: "*", hooks: [hook("PreToolUse")] }]);
  assert.deepEqual(out.hooks.Stop, snapshot.hooks.Stop);
  assert.deepEqual(out.hooks.SessionStart, [{ hooks: [hook("SessionStart")] }]);
});

test("mergeHooks: merging twice does not duplicate GRU entries", () => {
  const additions = claudeCodeConfig(paths).settings;
  const once = mergeHooks({ hooks: {} }, additions).merged;
  const twice = mergeHooks(once, additions);
  assert.deepEqual(twice, { merged: once, conflicts: [] });
  // The same command already present under another matcher also counts as present.
  const moved = { hooks: { PreToolUse: [{ matcher: "Bash|Read", hooks: [hook("PreToolUse")] }] } };
  const result = mergeHooks(moved, additions);
  assert.equal((result.merged as typeof moved).hooks.PreToolUse.length, 1);
});

test("mergeHooks: a non-object file or hooks value is a conflict and is returned unchanged", () => {
  const additions = claudeCodeConfig(paths).settings;
  for (const existing of [[1, 2], "text", 3, true]) {
    const { merged, conflicts } = mergeHooks(existing, additions);
    assert.equal(merged, existing);
    assert.equal(conflicts.length, 1);
  }
  const badHooks = { hooks: ["x"] };
  const result = mergeHooks(badHooks, additions);
  assert.equal(result.merged, badHooks);
  assert.equal(result.conflicts.length, 1);
});

test("mergeHooks: a non-array event entry is a conflict for that event only", () => {
  const { merged, conflicts } = mergeHooks({ hooks: { PreToolUse: { oops: true } } }, claudeCodeConfig(paths).settings);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0] ?? "", /hooks\.PreToolUse is not an array/);
  const out = merged as { hooks: Record<string, unknown> };
  assert.deepEqual(out.hooks.PreToolUse, { oops: true });
  assert.ok(Array.isArray(out.hooks.PostToolUse));
});

test("mergeHooks: a stale GRU hook with a different command is reported, not rewritten or doubled", () => {
  const stale = { type: "command", command: 'node "/old/cli.ts" hook claude-code PreToolUse --state "/old/state"', timeout: 15 };
  const existing = { hooks: { PreToolUse: [{ matcher: "*", hooks: [stale] }] } };
  const { merged, conflicts } = mergeHooks(existing, claudeCodeConfig(paths).settings);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0] ?? "", /different GRU hook/);
  assert.deepEqual((merged as typeof existing).hooks.PreToolUse, [{ matcher: "*", hooks: [stale] }]);
});

test("mergeMcpServers: other servers kept, identical gru not duplicated, a different gru is a conflict", () => {
  const additions = claudeCodeConfig(paths).mcp;
  const existing = { mcpServers: { github: { command: "gh-mcp", args: [] } } };
  const { merged } = mergeMcpServers(existing, additions);
  assert.deepEqual(merged, { mcpServers: { github: { command: "gh-mcp", args: [] }, gru: additions.mcpServers.gru } });
  assert.deepEqual(mergeMcpServers(merged, additions), { merged, conflicts: [] });
  const other = { mcpServers: { gru: { command: "python", args: ["x"] } } };
  const conflict = mergeMcpServers(other, additions);
  assert.deepEqual(conflict.merged, other);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(mergeMcpServers("nope", additions).conflicts.length, 1);
});

test("mergeCodexToml: appends once, and reports any existing gru server definition", () => {
  const snippet = codexConfig(paths).configTomlSnippet;
  const base = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const once = mergeCodexToml(base, snippet);
  assert.deepEqual(once.conflicts, []);
  assert.ok(once.merged.startsWith(base));
  assert.ok(once.merged.endsWith(snippet));
  assert.deepEqual(mergeCodexToml(once.merged, snippet), { merged: once.merged, conflicts: [] });
  assert.equal(mergeCodexToml("", snippet).merged, snippet);

  for (const existing of [
    '[mcp_servers.gru]\ncommand = "python"\n',
    '[mcp_servers."gru"]\ncommand = "python"\n',
    '[mcp_servers.gru.env]\nX = "1"\n',
    '[mcp_servers]\ngru = { command = "python" }\n',
    'mcp_servers.gru.command = "python"\n',
    'mcp_servers = { gru = { command = "python" } }\n',
  ]) {
    const result = mergeCodexToml(existing, snippet);
    assert.equal(result.merged, existing, existing);
    assert.equal(result.conflicts.length, 1, existing);
  }
});
