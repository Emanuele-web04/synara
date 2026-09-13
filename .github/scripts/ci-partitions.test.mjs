import assert from "node:assert/strict";
import { test } from "node:test";
import { chatPatterns } from "../../apps/web/vitest.browser.partitions.ts";
import { planChanges, readGraph } from "./ci-plan.mjs";

const patterns = chatPatterns(/^(?!.*\[geometry:linux\])/);
const ownership = (name) => Object.values(patterns).filter((pattern) => pattern.test(name)).length;
test("All stable browser cases have exactly one owner; quarantine has none", () => {
  for (const name of [
    "new regression with a previously unknown name",
    "restores streaming follow",
    "refreshes the full conversation when an approval was already answered",
    "keeps near-cap composer work bounded while live activities arrive",
    "preserves three answers (auto-advance)",
    "preserves three answers (manual)",
    "preserves three answers (custom)",
    "remembers Local and New worktree choices for subsequent project chats",
    "runs the setup action from the newly-created worktree before starting the turn",
  ]) {
    assert.equal(ownership(name), 1, name);
    assert.equal(ownership(`[geometry:linux] ${name}`), 0, name);
  }
});
test("Measured interaction cases move without removing existing follow cases", () => {
  assert.ok(patterns.follow.test("restores streaming follow after reconnect"));
  assert.ok(patterns.follow.test("preserves three answers (custom) on transient failure"));
  assert.ok(patterns.workflows.test("a future stable regression"));
});
test("Every planned unit suite retains independent production build validation", () => {
  const graph = readGraph(process.cwd());
  for (const path of [
    "apps/web/src/example.tsx",
    "apps/server/src/example.ts",
    "apps/desktop/src/example.ts",
    "packages/shared/src/example.ts",
    "packages/contracts/src/example.ts",
    "scripts/example.ts",
    "bun.lock",
    ".github/workflows/ci.yml",
  ]) {
    const plan = planChanges([path], graph);
    assert.equal(plan.unit, true);
    assert.equal(plan.build, true, path);
  }
});
