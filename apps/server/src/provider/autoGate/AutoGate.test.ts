import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { describe, expect, vi } from "vitest";

import { ServerSettingsService } from "../../serverSettings";
import {
  AutoGate,
  AutoGateBackend,
  AutoGateError,
  AutoGateLayer,
  type AutoGateModelState,
} from "./AutoGate";

const OPTIONS = [
  { kind: "allow_once" as const, optionId: "allow-once" },
  { kind: "reject_once" as const, optionId: "reject-once" },
];

const decideInput = {
  provider: "devin" as const,
  runtimeMode: "auto" as const,
  toolCall: { title: "Run command", rawInput: { command: "ls -la" } },
  options: OPTIONS,
};

const tempModelDir = () => join(mkdtempSync(join(tmpdir(), "autogate-")), "model");

function makeTestLayer(input: {
  readonly score: (text: string) => Effect.Effect<number, AutoGateError>;
  readonly autoEngine?: "native" | "local";
  readonly modelDir: string;
}) {
  return AutoGateLayer.pipe(
    Layer.provide(
      Layer.effect(
        AutoGateBackend,
        Effect.map(Ref.make<AutoGateModelState>({ state: "ready" }), (statusRef) =>
          AutoGateBackend.of({
            ensureReady: Effect.void,
            score: input.score,
            modelDir: input.modelDir,
            statusRef,
          }),
        ),
      ),
    ),
    Layer.provide(
      ServerSettingsService.layerTest({
        autoEngine: input.autoEngine ?? "local",
        autoGateThresholdPreset: "balanced",
      }),
    ),
  );
}

describe("AutoGate.decide", () => {
  it.effect("ignores non-auto runtime modes", () => {
    const score = vi.fn(() => Effect.succeed(0.01));
    return Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide({
        ...decideInput,
        runtimeMode: "approval-required",
      });
      expect(outcome).toBeUndefined();
      expect(score).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeTestLayer({ score, modelDir: tempModelDir() })));
  });

  it.effect("ignores auto mode while the engine is provider-native", () =>
    Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide(decideInput);
      expect(outcome).toBeUndefined();
    }).pipe(
      Effect.provide(
        makeTestLayer({
          score: () => Effect.succeed(0.01),
          autoEngine: "native",
          modelDir: tempModelDir(),
        }),
      ),
    ),
  );

  it.effect("selects the allow option for a confident allow", () =>
    Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide(decideInput);
      expect(outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
      const status = yield* gate.status;
      expect(status.counts).toEqual({ allowed: 1, denied: 0, escalated: 0 });
    }).pipe(
      Effect.provide(
        makeTestLayer({ score: () => Effect.succeed(0.05), modelDir: tempModelDir() }),
      ),
    ),
  );

  it.effect("selects the reject option for a confident deny", () =>
    Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide(decideInput);
      expect(outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    }).pipe(
      Effect.provide(
        makeTestLayer({ score: () => Effect.succeed(0.95), modelDir: tempModelDir() }),
      ),
    ),
  );

  it.effect("escalates to the approval card inside the uncertain band", () =>
    Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide(decideInput);
      expect(outcome).toBeUndefined();
      const status = yield* gate.status;
      expect(status.counts.escalated).toBe(1);
    }).pipe(
      Effect.provide(makeTestLayer({ score: () => Effect.succeed(0.5), modelDir: tempModelDir() })),
    ),
  );

  it.effect("always prompts for high-risk actions without scoring", () => {
    const score = vi.fn(() => Effect.succeed(0.01));
    return Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide({
        ...decideInput,
        toolCall: { title: "Run command", rawInput: { command: "rm -rf /" } },
      });
      expect(outcome).toBeUndefined();
      expect(score).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeTestLayer({ score, modelDir: tempModelDir() })));
  });

  it.effect("fails open to the approval card when scoring fails", () =>
    Effect.gen(function* () {
      const gate = yield* AutoGate;
      const outcome = yield* gate.decide(decideInput);
      expect(outcome).toBeUndefined();
      const status = yield* gate.status;
      expect(status.counts.escalated).toBe(1);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          score: () => Effect.fail(new AutoGateError("inference", "onnx exploded")),
          modelDir: tempModelDir(),
        }),
      ),
    ),
  );

  it.effect("appends a telemetry record for each verdict", () => {
    const modelDir = tempModelDir();
    return Effect.gen(function* () {
      const gate = yield* AutoGate;
      yield* gate.decide(decideInput);
      const telemetry = readFileSync(join(modelDir, "..", "auto-gate-telemetry.jsonl"), "utf8");
      const entry = JSON.parse(telemetry.trim());
      expect(entry.provider).toBe("devin");
      expect(entry.verdict).toBe("allow");
      expect(entry.pDeny).toBeCloseTo(0.05);
    }).pipe(Effect.provide(makeTestLayer({ score: () => Effect.succeed(0.05), modelDir })));
  });
});
