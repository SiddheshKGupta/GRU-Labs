// A plausible but wrong implementation. The must-fail check runs the tests
// against this file; if they pass, the tests are too weak to certify
// anything.
export function slugify(text) {
  return text.toLowerCase();
}
