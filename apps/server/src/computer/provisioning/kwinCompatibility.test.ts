import { describe, expect, it } from "vitest";

import { kwinDistributionSetupProblem, kwinVersionSetupProblem } from "./kwinCompatibility.ts";

describe("KWin setup compatibility", () => {
  it.each(["22.04", "24.04"])("rejects stock Ubuntu %s before installation", (versionId) => {
    expect(kwinDistributionSetupProblem({ id: "ubuntu", versionId })).toMatch(/KWin 5.*KWin 6/);
  });

  it("rejects Debian's older Qt 5 package set", () => {
    expect(kwinDistributionSetupProblem({ id: "debian", versionId: "12" })).toContain("Debian 13");
    expect(kwinDistributionSetupProblem({ id: "debian", versionId: "13" })).toBeUndefined();
  });

  it("does not confuse release numbers with decimal numbers", () => {
    expect(kwinDistributionSetupProblem({ id: "ubuntu", versionId: "24.10" })).toBeUndefined();
    expect(kwinDistributionSetupProblem({ id: "ubuntu", versionId: "26.04" })).toBeUndefined();
  });

  it("requires an identifiable release for the known versioned package sets", () => {
    expect(kwinDistributionSetupProblem({ id: "ubuntu" })).toContain("could not determine");
  });

  it("does not infer package compatibility for other distributions", () => {
    expect(kwinDistributionSetupProblem({ id: "arch" })).toBeUndefined();
    expect(kwinDistributionSetupProblem(undefined)).toBeUndefined();
  });

  it("rejects an installed KWin 5 regardless of distribution", () => {
    expect(kwinVersionSetupProblem("5.27.11")).toContain("KWin 5.27.11 is unsupported");
    expect(kwinVersionSetupProblem("6.3.6")).toBeUndefined();
    expect(kwinVersionSetupProblem(undefined)).toBeUndefined();
  });
});
