import { describe, expect, it } from "vitest";

import { parseCanaryArgs, resolveCanaryPaths, resolveCanaryRef } from "./canary";

describe("canary tooling", () => {
  it("keeps managed source and Canary data separate from Stable", () => {
    expect(resolveCanaryPaths({}, "/Users/tester")).toEqual({
      home: "/Users/tester/.synara-canary",
      source: "/Users/tester/.cache/synara-canary/source",
      state: "/Users/tester/.synara-canary/canary-state.json",
      pid: "/Users/tester/.synara-canary/canary.pid",
      log: "/Users/tester/.synara-canary/canary.log",
    });
  });

  it("supports explicit path overrides", () => {
    expect(
      resolveCanaryPaths(
        {
          SYNARA_CANARY_HOME: "/tmp/canary-data",
          SYNARA_CANARY_SOURCE: "/tmp/canary-source",
        },
        "/Users/tester",
      ),
    ).toEqual({
      home: "/tmp/canary-data",
      source: "/tmp/canary-source",
      state: "/tmp/canary-data/canary-state.json",
      pid: "/tmp/canary-data/canary.pid",
      log: "/tmp/canary-data/canary.log",
    });
  });

  it("tracks main by default and accepts a stacked PR ref", () => {
    expect(parseCanaryArgs(["update"])).toEqual({ command: "update", ref: null });
    expect(parseCanaryArgs(["setup", "--ref", "codex/synara-canary"])).toEqual({
      command: "setup",
      ref: "codex/synara-canary",
    });
  });

  it("keeps updating the selected stacked ref until explicitly moved to main", () => {
    expect(resolveCanaryRef(parseCanaryArgs(["setup"]), null)).toBe("main");
    expect(resolveCanaryRef(parseCanaryArgs(["update"]), "codex/synara-canary")).toBe(
      "codex/synara-canary",
    );
    expect(resolveCanaryRef(parseCanaryArgs(["update", "--ref", "main"]), "old-ref")).toBe("main");
  });

  it("rejects unsupported commands and incomplete refs", () => {
    expect(() => parseCanaryArgs(["reset"])).toThrow(/Unknown Canary command/u);
    expect(() => parseCanaryArgs(["update", "--ref"])).toThrow(/Missing value/u);
  });
});
