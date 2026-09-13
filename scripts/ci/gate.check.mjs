import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const gate = workflow.split("// BEGIN GATE CONTRACT (executed verbatim by gate.check.mjs)")[1]?.split("// END GATE CONTRACT")[0];
assert.ok(gate, "Missing executable gate contract");
const flags = ["typecheck", "product", "unit", "browser", "build", "windows"];
function fixture(enabled) {
  const outputs = Object.fromEntries(flags.map((key) => [key, String(enabled.includes(key))]));
  return {
    changes: { result: "success", outputs },
    "static-fast": { result: "success", outputs: {
      typecheck: outputs.typecheck === "true" ? "success" : "skipped",
      lineage: outputs.product === "true" ? "success" : "skipped",
      release: outputs.product === "true" ? "success" : "skipped",
    } },
    ...Object.fromEntries(Object.entries({ unit: "unit", browser: "browser", build: "build", windows_process: "windows" }).map(([lane, flag]) => [lane, { result: outputs[flag] === "true" ? "success" : "skipped" }])),
  };
}
function run(needs) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", gate], {
    env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) }, encoding: "utf8",
  });
}
for (const enabled of [flags, [], ["typecheck"], ["typecheck", "product", "unit", "build", "windows"]]) {
  test(`Gate accepts the exact planned outcomes: ${enabled.join(",") || "docs"}`, () => {
    const result = run(fixture(enabled));
    assert.equal(result.status, 0, result.stderr);
  });
}
for (const lane of ["changes", "static-fast", "unit", "browser", "build", "windows_process"]) {
  for (const status of ["failure", "cancelled", "skipped", undefined]) {
    test(`Gate rejects ${lane}=${status} when required`, () => {
      const needs = fixture(flags);
      needs[lane].result = status;
      assert.notEqual(run(needs).status, 0);
    });
  }
}
for (const flag of flags) {
  test(`Gate rejects missing or malformed admission output ${flag}`, () => {
    for (const value of [undefined, "", "TRUE", "null"]) {
      const needs = fixture([]);
      needs.changes.outputs[flag] = value;
      assert.notEqual(run(needs).status, 0);
    }
  });
}
for (const step of ["typecheck", "lineage", "release"]) {
  test(`Gate rejects silently skipped merged ${step}`, () => {
    const needs = fixture(flags);
    needs["static-fast"].outputs[step] = "skipped";
    assert.notEqual(run(needs).status, 0);
  });
}
test("Unplanned failed, cancelled or executed lanes cannot masquerade as intentional skips", () => {
  for (const status of ["failure", "cancelled", "success"]) {
    const needs = fixture([]);
    needs.browser.result = status;
    assert.notEqual(run(needs).status, 0);
  }
});
test("Required display name and full-history checkout remain intact", () => {
  assert.match(workflow, /name: Format, Lint, Typecheck, Test, Browser Test, Build/);
  assert.match(workflow, /fetch-depth: \$\{\{ needs\.changes\.outputs\.product == 'true' && '0' \|\| '1' \}\}/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});
