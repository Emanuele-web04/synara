import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { isCommandMissingCause } from "./providerCliOutput";
import { probeProviderCliVersion } from "./providerCliVersionProbe";

describe("provider CLI missing-command classification", () => {
  it("keeps existing ENOENT and NotFound classifications", () => {
    expect(isCommandMissingCause(new Error("spawn codex ENOENT"))).toBe(true);
    expect(isCommandMissingCause(new Error("NotFound: codex"))).toBe(true);
  });

  it("classifies normalized runner failures as a missing provider CLI", async () => {
    const outcome = await Effect.runPromise(
      probeProviderCliVersion(Effect.fail(new Error("Command not found: codex")), 1_000),
    );

    expect(outcome.outcome).toBe("missing");
  });
});
