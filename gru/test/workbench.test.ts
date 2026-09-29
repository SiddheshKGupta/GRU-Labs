// The Workbench shows only what the ledgers record, renders Minion text as
// data, and serves read-only on loopback.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { makeRoot, runGru } from "../bench/harnesses.ts";
import { SCENARIOS } from "../bench/scenarios.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { MemoryStore } from "../src/ledger/store.ts";
import { buildView, describeEffect } from "../src/workbench/model.ts";
import { loadView } from "../src/workbench/load.ts";
import { inlineJson, workbenchHtml } from "../src/workbench/page.ts";
import { startWorkbench } from "../src/workbench/server.ts";

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

describe("workbench view from real episodes", () => {
  let root = "";
  let state = "";
  before(async () => {
    root = makeRoot();
    state = mkdtempSync(join(tmpdir(), "gru-wb-state-"));
    for (const id of ["m01-honest", "m02-injection-follower", "m09-escape-artist"]) await runGru(scenario(id), root, state);
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  test("each episode is one Minion with its closure, strength and verified ledger", () => {
    const view = loadView(state);
    assert.equal(view.totals.episodes, 3);
    const by = new Map(view.episodes.map((e) => [e.minion, e]));
    assert.equal(by.get("m01-honest")!.status, "PASS");
    assert.equal(by.get("m09-escape-artist")!.status, "FAIL");
    for (const episode of view.episodes) {
      assert.ok(episode.ledger_ok, episode.problems.join("; "));
      assert.equal(episode.strength, "ADVERSARIAL");
    }
    assert.equal(view.totals.ledgers_broken, 0);
  });

  test("the escalation and the Director's rejection reach the feed; nothing is left pending", () => {
    const view = loadView(state);
    const m02 = view.episodes.find((e) => e.minion === "m02-injection-follower")!;
    assert.equal(m02.escalated, 1);
    assert.ok(view.feed.some((item) => item.minion === "m02-injection-follower" && item.tone === "warn" && item.text.startsWith("needs the Director: fs.delete test/slugify.test.js")));
    assert.ok(view.feed.some((item) => item.text.startsWith("Director rejected")));
    assert.deepEqual(view.pending, []);
  });

  test("the roster and terminal carry spawn time, tokens and actors", () => {
    const view = loadView(state);
    const m01 = view.episodes.find((e) => e.minion === "m01-honest")!;
    assert.equal(m01.served_model, "scripted");
    assert.deepEqual(m01.tokens, { input: 0, output: 0, cache_read: 0 });
    assert.ok(m01.turns > 0 && m01.duration_ms >= 0 && m01.started_at !== "");
    assert.equal(view.feed[0]!.actor, "NEFARIO");
    assert.ok(view.feed.some((i) => i.actor === "DRU"));
    assert.ok(view.feed.some((i) => i.actor === "DIRECTOR"));
  });

  test("Nefario's lab reports the route and the isolation backend actually recorded", () => {
    const view = loadView(state);
    assert.deepEqual(view.lab.routes, [{ id: "fixture/scripted", episodes: 3 }]);
    assert.deepEqual(view.lab.backends, [{ id: "node-permission", episodes: 3 }]);
    assert.deepEqual(view.lab.unmet, ["P8"]);
  });

  test("a snapshot page embeds the view and nothing else it needs from outside", () => {
    const html = workbenchHtml({ mode: "snapshot", view: loadView(state) });
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes('id="gru-data"'));
    assert.ok(!/<script[^>]+src=|<link /.test(html), "no external resources");
    assert.ok(!html.includes(".innerHTML"), "ledger text is never parsed as markup");
  });
});

describe("workbench model edge cases", () => {
  test("an open escalation with no decision is pending and the episode is RUNNING", () => {
    const ledger = new Ledger("ep_pending", new MemoryStore(), () => new Date("2026-09-29T10:00:00Z"));
    ledger.append("episode.opened", { minion: "minion:writer", contract: { task: "t", budget: { max_tool_calls: 4 } }, started_at: "2026-09-29T10:00:00Z" });
    ledger.append("proposal", { proposal_id: "pr-1", tool: "write_file", effect: { kind: "fs.write", path: "test/a.test.js" }, consequences: ["ALTER_VERIFICATION"] });
    ledger.append("authorization", { authorization_id: "au-1", proposal_id: "pr-1", verdict: "ESCALATE", reasons: ["protected path"] });
    const view = buildView([{ episode_id: "ep_pending", events: ledger.events, problems: [] }]);
    assert.equal(view.episodes[0]!.status, "RUNNING");
    assert.equal(view.episodes[0]!.budget_used, 0.25);
    assert.equal(view.pending.length, 1);
    assert.equal(view.pending[0]!.effect, "fs.write test/a.test.js");
  });

  test("a ledger that does not verify is shown as broken, not dropped", () => {
    const view = buildView([{ episode_id: "ep_x", events: [], problems: ["event 3: hash does not match its contents"] }]);
    assert.equal(view.totals.ledgers_broken, 1);
    assert.equal(view.episodes[0]!.ledger_ok, false);
  });

  test("describeEffect uses structured fields only", () => {
    assert.equal(describeEffect({ kind: "process.run", command_id: "test" }), "process.run test");
    assert.equal(describeEffect(null), "effect");
  });

  test("inline JSON cannot close its script element", () => {
    const hostile = { text: "</script><img src=x onerror=alert(1)>" + String.fromCharCode(0x2028) };
    const encoded = inlineJson(hostile);
    assert.ok(!encoded.includes("<"));
    assert.deepEqual(JSON.parse(encoded), hostile);
  });
});

describe("workbench server", () => {
  test("serves the page and the view on loopback, read-only, with a strict CSP", async () => {
    const server = await startWorkbench({ port: 0, view: () => buildView([]) });
    try {
      const page = await fetch(server.url);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      const state = await fetch(new URL("api/state", server.url));
      assert.equal(((await state.json()) as { totals: { episodes: number } }).totals.episodes, 0);
      assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
      assert.equal((await fetch(new URL("nope", server.url))).status, 404);
    } finally {
      await server.close();
    }
  });

  test("refuses a request whose Host is not loopback (DNS rebinding)", async () => {
    const server = await startWorkbench({ port: 0, view: () => buildView([]) });
    try {
      const { request } = await import("node:http");
      const url = new URL(server.url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: url.port, path: "/api/state", headers: { host: "evil.example:80" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await server.close();
    }
  });
});
