import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, expandHome, loadConfig } from "../src/config.ts";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gru-config-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = { HOME: home };
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  return { root, home, cwd, env, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("no config file anywhere gives the defaults", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const loaded = loadConfig({ cwd: s.cwd, env: s.env });
  assert.equal(loaded.source, null);
  assert.deepEqual(loaded.config, {
    providers: [],
    route: null,
    director: "interactive",
    state_dir: join(s.home, ".gru", "state"),
  });
});

test("search order: --config, then ./gru.config.json, then ~/.config/gru/config.json", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const userConfig = join(s.home, ".config", "gru", "config.json");
  const projectConfig = join(s.cwd, "gru.config.json");
  const explicit = join(s.root, "explicit.json");
  s.write(userConfig, { route: "user/model" });
  assert.equal(loadConfig({ cwd: s.cwd, env: s.env }).config.route, "user/model");
  s.write(projectConfig, { route: "project/model" });
  const project = loadConfig({ cwd: s.cwd, env: s.env });
  assert.equal(project.config.route, "project/model");
  assert.equal(project.source, projectConfig);
  s.write(explicit, { route: "explicit/model" });
  const chosen = loadConfig({ cwd: s.cwd, explicitPath: "../explicit.json", env: s.env });
  assert.equal(chosen.config.route, "explicit/model");
  assert.equal(chosen.source, explicit);
});

test("files are not merged: the first one found is the whole config", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.write(join(s.home, ".config", "gru", "config.json"), { route: "user/model", director: "deny" });
  s.write(join(s.cwd, "gru.config.json"), { route: "project/model" });
  assert.equal(loadConfig({ cwd: s.cwd, env: s.env }).config.director, "interactive");
});

test("an explicit --config that does not exist is an error, not a fallback", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.write(join(s.cwd, "gru.config.json"), { route: "project/model" });
  assert.throws(() => loadConfig({ cwd: s.cwd, explicitPath: "missing.json", env: s.env }), /config file not found/);
});

test("a leading ~ expands to the home directory in state_dir and --config", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.write(join(s.home, "configs", "gru.json"), { state_dir: "~/ledgers" });
  const loaded = loadConfig({ cwd: s.cwd, explicitPath: "~/configs/gru.json", env: s.env });
  assert.equal(loaded.config.state_dir, join(s.home, "ledgers"));
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~other/x", "/h"), "~other/x");
  assert.equal(expandHome("a/~/b", "/h"), "a/~/b");
});

test("a relative state_dir is relative to the config file", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.write(join(s.cwd, "gru.config.json"), { state_dir: "../state" });
  assert.equal(loadConfig({ cwd: s.cwd, env: s.env }).config.state_dir, join(s.root, "state"));
});

test("an API key anywhere in the file is refused, and the message never contains it", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const secret = "sk-ant-api03-SECRETSECRETSECRET1234";
  const cases: unknown[] = [
    { providers: [{ id: "a", api_key: secret }] },
    { providers: [{ id: "a", headers: { Authorization: `Bearer ${secret}` } }] },
    { route: secret },
    { providers: [{ id: "a", models: ["x", secret] }] },
  ];
  for (const value of cases) {
    s.write(join(s.cwd, "gru.config.json"), value);
    let error: unknown;
    try {
      loadConfig({ cwd: s.cwd, env: s.env });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ConfigError, JSON.stringify(value));
    assert.match(error.message, /environment variables/);
    assert.ok(!error.message.includes("SECRETSECRET"), "the key must not be echoed");
  }
});

test("a syntax error near a key does not echo the key", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.write(join(s.cwd, "gru.config.json"), '{"providers": [{"api_key": sk-ant-SECRETSECRETSECRET}]}');
  assert.throws(
    () => loadConfig({ cwd: s.cwd, env: s.env }),
    // V8 quotes about ten characters of source ("sk-ant-SEC"), so check for the prefix.
    (error: Error) => error instanceof ConfigError && /not valid JSON/.test(error.message) && !error.message.includes("sk-ant"),
  );
});

test("unknown keys and wrong types are rejected", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const bad: [unknown, RegExp][] = [
    [{ provider: [] }, /unknown key "provider"/],
    [{ providers: {} }, /"providers" must be an array/],
    [{ providers: ["anthropic"] }, /providers\[0\] must be an object/],
    [{ director: "yes" }, /"director" must be/],
    [{ route: "" }, /"route" must be/],
    [{ state_dir: 3 }, /"state_dir" must be/],
    [[], /must be a JSON object/],
  ];
  for (const [value, pattern] of bad) {
    s.write(join(s.cwd, "gru.config.json"), value);
    assert.throws(() => loadConfig({ cwd: s.cwd, env: s.env }), pattern, JSON.stringify(value));
  }
});

test("known keys are accepted and providers pass through for the catalog to validate", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const providers = [{ id: "local", kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1", api_key_env: null }];
  s.write(join(s.cwd, "gru.config.json"), { providers, route: "local/qwen", director: "deny", state_dir: "/var/gru" });
  assert.deepEqual(loadConfig({ cwd: s.cwd, env: s.env }).config, {
    providers,
    route: "local/qwen",
    director: "deny",
    state_dir: "/var/gru",
  });
});
