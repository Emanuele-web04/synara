import assert from "node:assert/strict";
import { test } from "node:test";
import { selectInstall, installPlan } from "./ci-install.mjs";
import { readGraph } from "./ci-plan.mjs";
import { readFileSync } from "node:fs";

const graph = readGraph(process.cwd());
const root = JSON.parse(readFileSync("package.json", "utf8"));
test("Runtime installation excludes only the unrelated marketing dependency tree", () => {
  assert.deepEqual(selectInstall("runtime", graph, root), {
    profile: "runtime",
    args: ["--filter", "!@synara/marketing"],
  });
});
test("New workspace and root consumers disable the exclusion", () => {
  for (const owner of Object.keys(graph).filter((name) => name !== "@synara/marketing")) {
    assert.equal(
      selectInstall("runtime", { ...graph, [owner]: [...graph[owner], "@synara/marketing"] }, root)
        .profile,
      "full",
    );
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.equal(
      selectInstall("runtime", graph, { [field]: { "@synara/marketing": "workspace:*" } }).profile,
      "full",
    );
  }
});
test("Device installs include the complete forward workspace closure", () => {
  assert.deepEqual(selectInstall("device", graph, root).args, ["--filter", "@synara/scripts..."]);
});
test("Full installation and uncertain graphs stay broad; invalid profiles fail", () => {
  assert.deepEqual(installPlan("full", process.cwd()), { profile: "full", args: [] });
  assert.deepEqual(installPlan("runtime", "/does-not-exist"), { profile: "full", args: [] });
  assert.throws(() => installPlan("typo", process.cwd()), /Unknown installation profile/);
});
