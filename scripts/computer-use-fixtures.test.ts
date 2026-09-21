// FILE: computer-use-fixtures.test.ts
// Purpose: Pins the canary fixture's LaunchServices invocation to the
//   non-activating `open -g` form so fixture apps can never steal the
//   operator's focus or switch their Space at launch.
// Layer: Fixture launch policy
// Depends on: scripts/computer-use-fixtures/belief-canary.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./computer-use-fixtures/belief-canary.mjs", import.meta.url),
);
const scriptSource = readFileSync(scriptPath, "utf8");

describe("belief-canary launch", () => {
  it("prints a non-activating launch command: -g -n -W -a", () => {
    const printed = execFileSync(process.execPath, [scriptPath, "--print"], {
      encoding: "utf8",
    }).trim();
    // -g is the load-bearing flag: without it `open` makes the app frontmost
    // and can pull the operator onto the fixture's Space.
    expect(printed).toMatch(/^open -g -n -W -a /u);
    expect(printed).toContain("--env SYNARA_CUA_CANARY_DIR=");
    expect(printed).not.toMatch(/^open -n/u);
  });

  it("spawns the same non-activating flags it prints", () => {
    // The real launch path and the printed command share one flag list, so a
    // printed `-g` guarantee cannot drift from what `open` actually receives.
    expect(scriptSource).toContain('const CANARY_OPEN_FLAGS = ["-g", "-n", "-W"]');
    expect(scriptSource).toMatch(/spawnSync\(\s*"\/usr\/bin\/open",\s*canaryOpenArgs\(/u);
  });
});
