import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayUrl,
  makeStyle,
  renderCall,
  renderEscalation,
  renderReport,
  renderTurn,
  safeText,
} from "../src/cli/render.ts";
import { call, escalationRequest, report, turn } from "./terminal-fake-blocks.ts";

const ESC = "\u001b";

test("colour only on a terminal, and never when NO_COLOR is set", () => {
  assert.equal(makeStyle({ isTTY: true, env: {} }).color, true);
  assert.equal(makeStyle({ isTTY: true, env: {} }).red("x"), `${ESC}[31mx${ESC}[39m`);
  assert.equal(makeStyle({ isTTY: true, env: { NO_COLOR: "1" } }).color, false);
  assert.equal(makeStyle({ isTTY: true, env: { NO_COLOR: "1" } }).red("x"), "x");
  assert.equal(makeStyle({ isTTY: true, env: { NO_COLOR: "" } }).color, true, "an empty NO_COLOR does not disable colour");
  assert.equal(makeStyle({ isTTY: false, env: {} }).bold("x"), "x");
});

test("rendered reports carry no escape codes when colour is off", () => {
  const plain = makeStyle({ isTTY: false, env: {} });
  assert.ok(!renderReport(report("FAIL"), plain).includes(ESC));
});

test("safeText escapes control characters and bidi overrides", () => {
  assert.equal(safeText(`a${ESC}[31mb`), "a\\x1b[31mb");
  assert.equal(safeText("line1\nline2\r"), "line1\\nline2\\r");
  assert.equal(safeText("line1\nline2", { multiline: true }), "line1\nline2");
  assert.equal(safeText(`x${String.fromCodePoint(0x202e)}y`), "x\\u202ey");
  assert.equal(safeText(`${String.fromCodePoint(0x2066)}z`), "\\u2066z");
  assert.equal(safeText("\u0007\u009b"), "\\x07\\x9b");
  assert.match(safeText("abcdef", { max: 3 }), /^abc… \(3 more characters\)$/);
});

test("model text, tool input and tool output cannot put raw escapes on the terminal", () => {
  const style = makeStyle({ isTTY: true, env: {} });
  const hostile = `${ESC}]0;owned${ESC}\\${ESC}[2J`;
  const outputs = [
    renderTurn(turn({ text: `hello ${hostile}` }), style),
    renderCall(call("c", "read_file", { path: `x${hostile}` }), { call_id: "c", ok: false, content: `denied ${hostile}` }, style),
    renderEscalation(escalationRequest({ reasons: [hostile], effect: { kind: "fs.delete", path: hostile } }), style),
    renderReport(report("FAIL", { violations: [hostile], closure: { status: "FAIL", rationale: hostile } }), style),
  ];
  for (const output of outputs) {
    // Our own colour codes are SGR sequences ending in "m"; nothing else may appear.
    const foreign = output.replace(/\u001b\[\d+m/g, "");
    assert.ok(!foreign.includes(ESC), JSON.stringify(output));
  }
});

test("URLs are shown without credentials or query strings", () => {
  assert.equal(displayUrl("https://u:p@host.test:8443/v1?key=abc"), "https://host.test:8443/v1?…");
  assert.equal(displayUrl(null), "-");
  assert.equal(displayUrl("not a url sk-123"), "(unparseable url)");
});

test("a truncated turn says its calls are not run", () => {
  const plain = makeStyle({ isTTY: false, env: {} });
  assert.match(renderTurn(turn({ stop: "max_tokens", calls: [call("a")] }), plain), /its tool calls are not run/);
  assert.match(renderTurn(turn({ served_model: "fallback-1" }), plain, "primary"), /served by fallback-1/);
});
