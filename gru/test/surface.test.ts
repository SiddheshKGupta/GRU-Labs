// The effect-surface audit as a test.
//
// Escapement Core's founding claim ("v1 has no model-to-effect path") was
// evidenced by grepping three patterns across two of fourteen files and was
// false. This test is the audit made executable: every source file is
// scanned, every effectful module is allowed only where the architecture
// says it lives, and the test first proves it can see the effect sites it
// is supposed to police -- a check that can find nothing passes vacuously.
//
// Ceiling: this is a lexical scan of import specifiers and a few call
// patterns, not a type-aware analysis. It does not see effects reached
// through an allowed module passed around as a value.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// Effectful specifier -> the only source files allowed to import it.
const ALLOWED: Record<string, readonly string[]> = {
  // Reading the Director's own files (contract, config, fixtures) is T0 input, not a Minion effect.
  "node:fs": ["ledger/store.ts", "executors/workspace.ts", "executors/isolation.ts", "config.ts", "cli/main.ts", "cli/repl.ts", "cli/host-commands.ts", "cli/workbench-command.ts", "hooks/daemon.ts"],
  // The hook daemon and client stat, chmod and unlink their own unix socket; nothing else.
  "node:fs/promises": ["hooks/daemon.ts", "hooks/client.ts"],
  "node:child_process": ["executors/process.ts"],
  "node:net": ["hooks/daemon.ts", "hooks/client.ts"],
  "node:readline": ["director/channels.ts", "cli/repl.ts", "cli/main.ts"],
  "@anthropic-ai/sdk": ["routes/anthropic.ts"],
  // The Workbench: a read-only GET server bound to 127.0.0.1 (CDR-008).
  "node:http": ["workbench/server.ts"],
};
const FORBIDDEN = new Set([
  "node:https", "node:http2", "node:dgram", "node:tls", "node:worker_threads",
  "node:cluster", "node:vm", "node:inspector", "node:module", "node:v8", "node:repl",
]);
// Pure or stream-only built-ins any file may use.
const PURE = new Set(["node:crypto", "node:path", "node:url", "node:os", "node:util", "node:stream", "node:events", "node:string_decoder", "node:buffer", "node:timers/promises"]);
// workbench/page.ts: the fetch is browser code in the page, polling its own loopback origin (CSP connect-src 'self').
const FETCH_ALLOWED = new Set(["routes/openai-compatible.ts", "routes/providers.ts", "workbench/page.ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function rel(path: string): string {
  return relative(SRC, path).split(sep).join("/");
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/** Strip comments so prose about `exec` or `shell: true` is not flagged. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = sources(SRC).map((path) => ({ path: rel(path), text: readFileSync(path, "utf8") }));

test("the scan sees the whole source tree and the effect sites it polices", () => {
  assert.ok(files.length >= 25, `only ${files.length} source files found`);
  const importers = (spec: string) => files.filter((file) => specifiers(file.text).includes(spec)).map((file) => file.path);
  assert.deepEqual(importers("node:child_process"), ["executors/process.ts"]);
  assert.ok(importers("@anthropic-ai/sdk").includes("routes/anthropic.ts"), "SDK import not detected");
  assert.ok(importers("node:fs").includes("ledger/store.ts"), "store fs import not detected");
});

for (const file of files) {
  test(`effect surface: ${file.path}`, () => {
    const body = code(file.text);
    for (const spec of specifiers(file.text)) {
      if (spec.startsWith(".")) continue;
      if (PURE.has(spec)) continue;
      assert.ok(!FORBIDDEN.has(spec), `${file.path} imports forbidden module ${spec}`);
      const allowed = ALLOWED[spec];
      assert.ok(allowed !== undefined, `${file.path} imports ${spec}, which no rule admits (unprefixed built-in or undeclared dependency?)`);
      assert.ok(allowed.includes(file.path), `${file.path} may not import ${spec}; allowed in: ${allowed.join(", ") || "nowhere"}`);
    }
    assert.doesNotMatch(body, /\brequire\s*\(|\bcreateRequire\b/, `${file.path}: CommonJS require bypasses this scan`);
    assert.doesNotMatch(body, /\bimport\s*\(\s*[^"'\s)]/, `${file.path}: non-literal dynamic import bypasses this scan`);
    assert.doesNotMatch(body, /\bprocess\.(binding|dlopen)\b/, `${file.path}: native binding access`);
    assert.doesNotMatch(body, /\beval\s*\(|\bnew\s+Function\s*\(/, `${file.path}: dynamic code evaluation`);
    assert.doesNotMatch(body, /\bshell\s*:\s*true\b/, `${file.path}: shell: true`);
    // A bare exec( is child_process.exec destructured; RegExp.prototype.exec
    // is always reached through a dot and is harmless. A namespaced
    // child_process.exec needs the node:child_process import, confined above.
    assert.doesNotMatch(body, /(?<![.\w$])exec(Sync)?\s*\(/, `${file.path}: exec runs a string through a shell`);
    if (!FETCH_ALLOWED.has(file.path)) {
      assert.doesNotMatch(body, /\bfetch\s*\(/, `${file.path}: network access outside the route blocks`);
    }
  });
}
