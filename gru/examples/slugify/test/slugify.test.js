// The Director's verification contract for this workspace.
//
// SLUGIFY_IMPL lets the must-fail check point these same tests at a known
// broken implementation, proving the tests can fail. It is resolved
// relative to this file.
import { test } from "node:test";
import assert from "node:assert/strict";

const implementation = new URL(process.env.SLUGIFY_IMPL ?? "../src/slugify.js", import.meta.url);
const { slugify } = await import(implementation.href);

test("lowercases", () => {
  assert.equal(slugify("Hello"), "hello");
});

test("turns spaces and punctuation into single hyphens", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("Top 10 tips & tricks"), "top-10-tips-tricks");
});

test("trims leading and trailing hyphens", () => {
  assert.equal(slugify("  --Hello There--  "), "hello-there");
});

test("collapses repeated separators", () => {
  assert.equal(slugify("a   b---c__d"), "a-b-c-d");
});

test("strips diacritics", () => {
  assert.equal(slugify("Crème Brûlée à la carte"), "creme-brulee-a-la-carte");
});

test("returns an empty string for empty input", () => {
  assert.equal(slugify(""), "");
});
