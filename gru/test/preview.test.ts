// The Director approves what they can see: AVL builds the preview from the
// exact payload the digest binds, and every Director surface shows it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadContract, makeRoot, makeWorkspace } from "../bench/harnesses.ts";
import { principal } from "../src/avl/principal.ts";
import { effectPreview, PREVIEW_MAX_LINES } from "../src/avl/preview.ts";
import { defaultBlocks } from "../src/blocks.ts";
import { renderEscalation } from "../src/cli/render.ts";
import { runMinion } from "../src/minion/loop.ts";
import { escalationMessage } from "../src/mcp/server.ts";
import type { DirectorChannel, EscalationRequest } from "../src/types.ts";

const plain = { yellow: (s: string) => s, bold: (s: string) => s } as unknown as Parameters<typeof renderEscalation>[1];

test("an escalated test rewrite shows the Director the new content, bound to its digest", async () => {
  const root = makeRoot();
  const state = mkdtempSync(join(tmpdir(), "gru-preview-state-"));
  try {
    const workspace = makeWorkspace(root, "preview");
    const contract = loadContract();
    const seen: EscalationRequest[] = [];
    const director: DirectorChannel = {
      decide: async (request) => {
        seen.push(request);
        return { decision: "REJECT", actor: "director:test", reason: "no" };
      },
    };
    const route = defaultBlocks.fixtureRoute({
      turns: [{ calls: [{ name: "write_file", input: { path: "test/slugify.test.js", content: "import { test } from \"node:test\";\ntest(\"slugify\", () => {});\n" } }] }, { text: "done" }],
    });
    const session = await defaultBlocks.openSession({
      contract, workspace, state_dir: state, route: route.descriptor, director,
      minion: principal("minion", "weakener"), executor: defaultBlocks.executor(workspace, contract.commands),
    });
    const loop = await runMinion({ session, route });
    await session.close(loop.outcome);
    assert.equal(seen.length, 1);
    const preview = seen[0]!.preview ?? "";
    assert.match(preview, /^write test\/slugify\.test\.js: replaces the existing file, \d+ bytes, sha256 [0-9a-f]{16}/);
    assert.match(preview, /2 \| test\("slugify", \(\) => \{\}\);/);
    assert.ok(renderEscalation(seen[0]!, plain).includes('test("slugify", () => {});'));
    assert.ok(escalationMessage(seen[0]!).includes('test("slugify", () => {});'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("long payloads are cut with a count of what was not shown", () => {
  const payload = Array.from({ length: PREVIEW_MAX_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
  const preview = effectPreview({ kind: "fs.write", path: "a.txt", content_sha256: "0".repeat(64), bytes: payload.length } as never, payload, { target_exists: false });
  assert.match(preview, /creates a new file/);
  assert.match(preview, /\.\.\. 5 more lines not shown$/);
});

test("the terminal renders Minion content as text: escape sequences are neutralised", () => {
  const request: EscalationRequest = {
    authorization_id: "au-1", proposal_id: "pr-1", principal: "minion:x", tool: "write_file",
    effect: { kind: "fs.delete", path: "a" } as never, consequences: [], reasons: [],
    preview: "evil \u001b[2J\u001b]0;pwned\u0007 text",
  };
  assert.ok(!renderEscalation(request, plain).includes("\u001b"));
});
