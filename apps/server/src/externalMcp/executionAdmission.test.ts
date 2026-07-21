import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { makeExternalMcpExecutionAdmission } from "./executionAdmission.ts";

describe("external MCP execution admission", () => {
  it("rejects excess work per integration, isolates integrations, and evicts idle limiters", async () => {
    const admission = makeExternalMcpExecutionAdmission(2);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = [
      Effect.runPromise(admission.run("integration-a", Effect.promise(() => blocked))),
      Effect.runPromise(admission.run("integration-a", Effect.promise(() => blocked))),
    ];
    const deadline = Date.now() + 1_000;
    while (admission.activeIntegrationCount() !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const rejected = await Effect.runPromise(
      admission.run("integration-a", Effect.succeed("should-not-run")),
    );
    expect(Option.isNone(rejected)).toBe(true);
    await expect(
      Effect.runPromise(admission.run("integration-b", Effect.succeed("isolated"))),
    ).resolves.toEqual(Option.some("isolated"));

    release();
    await Promise.all(running);
    expect(admission.activeIntegrationCount()).toBe(0);
  });
});
