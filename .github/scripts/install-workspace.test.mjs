import assert from "node:assert/strict";
import { test } from "node:test";

import { installArgs } from "./install-workspace.mjs";

for (const profile of ["full", "product", "release", "device"]) {
  test(`${profile} always uses the frozen lockfile`, () => {
    const args = installArgs(profile);
    assert.equal(args[0], "install");
    assert.ok(args.includes("--frozen-lockfile"));
    assert.equal(args.includes("--ignore-scripts"), ["release", "device"].includes(profile));
  });
}

test("full remains unfiltered, preserving whole-workspace checks", () => {
  assert.deepEqual(installArgs(), ["install", "--frozen-lockfile"]);
});

test("product includes root tools, native packaging and workspace dependency closure", () => {
  assert.deepEqual(installArgs("product"), [
    "install",
    "--frozen-lockfile",
    "--filter",
    "./",
    "--filter",
    "@synara/cli...",
    "--filter",
    "@synara/desktop...",
    "--filter",
    "@synara/scripts...",
  ]);
});

test("release uses the same closure without changing its existing lifecycle policy", () => {
  assert.deepEqual(
    installArgs("release").filter((arg) => arg !== "--ignore-scripts"),
    installArgs("product"),
  );
});

test("device retains shared/contracts through scripts, excluding application-only dependencies", () => {
  assert.deepEqual(installArgs("device"), [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--filter",
    "./",
    "--filter",
    "@synara/scripts...",
  ]);
});

test("unknown profiles and shell expressions fail closed", () => {
  for (const profile of ["", "prod", "product; echo unsafe", "--ignore-scripts"]) {
    assert.throws(() => installArgs(profile), /Unknown workspace install profile/);
  }
});
