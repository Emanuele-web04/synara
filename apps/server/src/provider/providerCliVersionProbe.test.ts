import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { probeProviderCliVersion } from "./providerCliVersionProbe";

const success = { stdout: "1.2.3", stderr: "", code: 0 } as const;

describe("probeProviderCliVersion", () => {
  it("classifies successful and nonzero command results", async () => {
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.succeed(success), 100)),
    ).resolves.toEqual({ outcome: "success", result: success });

    const nonzero = { stdout: "", stderr: "failed", code: 2 } as const;
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.succeed(nonzero), 100)),
    ).resolves.toEqual({ outcome: "nonzero", result: nonzero });
  });

  it("distinguishes missing commands from other execution failures", async () => {
    const missing = new Error("spawn provider ENOENT");
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.fail(missing), 100)),
    ).resolves.toEqual({ outcome: "missing", cause: missing });

    const failure = new Error("permission denied");
    await expect(
      Effect.runPromise(probeProviderCliVersion(Effect.fail(failure), 100)),
    ).resolves.toEqual({ outcome: "failure", cause: failure });
  });

  it("classifies timeouts", async () => {
    await expect(Effect.runPromise(probeProviderCliVersion(Effect.never, 1))).resolves.toEqual({
      outcome: "timeout",
    });
  });
});
