// Source-level check: the Stable desktop must never start the CUA driver host
// or its Escape kill-switch monitors. Those live inside `startCuaHost` in
// main.ts, a module whose import side effects make a runtime test impractical,
// so this pins the gate's shape instead of executing it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

describe("computer use Stable gate", () => {
  it("returns from startCuaHost before touching the driver or monitors", () => {
    const fnStart = MAIN_SOURCE.indexOf("async function startCuaHost()");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const body = MAIN_SOURCE.slice(fnStart, fnStart + 4000);

    const gate = body.indexOf('isBetaFeatureEnabled("computerUse", desktopFlavor)');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(body.slice(gate)).toContain("return");

    // The gate must precede every driver/monitor construction in the function.
    for (const marker of [
      "new LinuxEscapeKillSwitchMonitor(",
      "new CuaDriverHost(",
      "new EscapeKillSwitchMonitor(",
      "createLinuxCuaDriverHost(",
      "attachCuaHost(",
    ]) {
      const idx = body.indexOf(marker);
      expect(idx, `${marker} must exist inside startCuaHost`).toBeGreaterThanOrEqual(0);
      expect(idx, `${marker} must stay behind the flavor gate`).toBeGreaterThan(gate);
    }
  });

  it("still sweeps orphaned cua drivers on Stable", () => {
    const fnStart = MAIN_SOURCE.indexOf("async function startCuaHost()");
    const body = MAIN_SOURCE.slice(fnStart, fnStart + 4000);
    const sweep = body.indexOf("sweepOrphanedCuaDrivers()");
    const gate = body.indexOf('isBetaFeatureEnabled("computerUse", desktopFlavor)');
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(sweep).toBeLessThan(gate);
  });
});
