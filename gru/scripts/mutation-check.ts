// Proves the tests can fail.
//
// Continuum's contract checker passed the exact defect it was written to
// catch, and two of its announced fixes were structurally inert. So each
// guarantee below has a mutant: a copy of the package with that one
// guarantee removed. The named tests must go red against the mutant and
// green against the original. A mutation whose site no longer exists is a
// failure too -- a stale mutant is a check that can no longer fail.
//
// The source tree is never modified; every mutant runs in a throwaway copy.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Mutant {
  id: string;
  guarantee: string;
  file: string;
  find: string;
  replace: string;
  tests: string[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const MUTANTS: Mutant[] = [
  {
    id: "gate-no-digest-check",
    guarantee: "S8: execution must match the authorized effect",
    file: "src/avl/gate.ts",
    find: "if (digestNow !== action.digest) {",
    replace: "if (false) {",
    tests: ["test/executors-workspace.test.ts", "test/conformance/conformance.test.ts"],
  },
  {
    id: "gate-no-replay-check",
    guarantee: "P9: an authorization is single use",
    file: "src/avl/gate.ts",
    find: "if (this.#consumed.has(action.authorization_id)) {",
    replace: "if (false) {",
    tests: ["test/conformance/conformance.test.ts"],
  },
  {
    id: "gate-ignores-revocation",
    guarantee: "P10: revocation is checked at execution",
    file: "src/avl/gate.ts",
    find: "if (!this.isActive(grantId, now)) {",
    replace: "if (false) {",
    tests: ["test/conformance/conformance.test.ts"],
  },
  {
    id: "gate-accepts-forgeries",
    guarantee: "only the gate mints authorizations",
    file: "src/avl/gate.ts",
    find: "if (!AuthorizedAction.isGenuine(action) || !this.#minted.has(action)) {",
    replace: "if (false) {",
    tests: ["test/conformance/conformance.test.ts"],
  },
  {
    id: "verification-alteration-pregrantable",
    guarantee: "ALTER_VERIFICATION always needs the Director",
    file: "src/avl/consequence.ts",
    find: 'ALTER_VERIFICATION: { scope: null, approval: "always" },',
    replace: 'ALTER_VERIFICATION: { scope: "workspace:write", approval: "unless-scope" },',
    tests: ["test/conformance/conformance.test.ts"],
  },
  {
    id: "delete-not-destructive",
    guarantee: "route equivalence: fs.delete carries DESTROY_WORKSPACE_DATA",
    file: "src/avl/consequence.ts",
    find: ': ["DESTROY_WORKSPACE_DATA"];',
    replace: ': ["MODIFY_WORKSPACE"];',
    tests: ["test/conformance/conformance.test.ts"],
  },
];

function run(dir: string, tests: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--test", ...tests], {
    cwd: dir,
    shell: false,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function copyPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "gru-mutant-"));
  for (const entry of ["src", "test", "examples", "package.json", "tsconfig.json"]) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function main(): number {
  const filter = process.argv[2];
  const mutants = filter ? MUTANTS.filter((mutant) => mutant.id === filter) : MUTANTS;
  let failures = 0;
  const allTests = [...new Set(mutants.flatMap((mutant) => mutant.tests))];
  const baseline = run(ROOT, allTests);
  if (baseline.status !== 0) {
    console.log("BASELINE FAILED -- the unmutated tests must pass first\n" + baseline.output.slice(-4000));
    return 1;
  }
  console.log(`baseline: ${allTests.length} test file(s) pass unmutated`);
  for (const mutant of mutants) {
    const dir = copyPackage();
    try {
      const path = join(dir, mutant.file);
      const text = readFileSync(path, "utf8");
      const occurrences = text.split(mutant.find).length - 1;
      if (occurrences !== 1) {
        console.log(`STALE     ${mutant.id}: site found ${occurrences} times in ${mutant.file} (need exactly 1)`);
        failures++;
        continue;
      }
      writeFileSync(path, text.replace(mutant.find, mutant.replace));
      const result = run(dir, mutant.tests);
      if (result.status === 0) {
        console.log(`SURVIVED  ${mutant.id}: ${mutant.guarantee} -- no test noticed`);
        failures++;
      } else {
        console.log(`KILLED    ${mutant.id}: ${mutant.guarantee}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${mutants.length - failures}/${mutants.length} mutants killed`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
