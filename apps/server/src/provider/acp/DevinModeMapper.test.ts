import { describe, it, assert } from "@effect/vitest";
import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { ThreadId } from "@t3tools/contracts";

import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import type { AcpSessionMode, AcpSessionModeState } from "./AcpRuntimeModel.ts";
import { resolveDevinModeId, applyDevinModeSelection } from "./DevinModeMapper.ts";

const threadId = ThreadId.makeUnsafe("thread-test");

function makeMode(id: string, name: string, description?: string): AcpSessionMode {
  return { id, name, ...(description ? { description } : {}) };
}

function makeModeState(
  currentModeId: string,
  availableModes: ReadonlyArray<AcpSessionMode>,
): AcpSessionModeState {
  return { currentModeId, availableModes };
}

function makeMockRuntime(input?: {
  readonly modeState?: AcpSessionModeState;
  readonly onSetMode?: (modeId: string) => void;
  readonly setModeEffect?: Effect.Effect<EffectAcpSchema.SetSessionModeResponse, unknown>;
}) {
  const setMode = (modeId: string) => {
    input?.onSetMode?.(modeId);
    return input?.setModeEffect ?? Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse);
  };

  return {
    getModeState: Effect.succeed(input?.modeState),
    setMode,
    handleRequestPermission: () => Effect.void,
    handleElicitation: () => Effect.void,
    handleReadTextFile: () => Effect.void,
    handleWriteTextFile: () => Effect.void,
    handleCreateTerminal: () => Effect.void,
    handleTerminalOutput: () => Effect.void,
    handleTerminalWaitForExit: () => Effect.void,
    handleTerminalKill: () => Effect.void,
    handleTerminalRelease: () => Effect.void,
    handleSessionUpdate: () => Effect.void,
    handleElicitationComplete: () => Effect.void,
    handleUnknownExtRequest: () => Effect.void,
    handleUnknownExtNotification: () => Effect.void,
    handleExtRequest: () => Effect.void,
    handleExtNotification: () => Effect.void,
  } as unknown as AcpSessionRuntimeShape;
}

describe("resolveDevinModeId", () => {
  it("plan interactionMode picks the mode whose name matches plan", () => {
    const modes = [makeMode("code", "Code"), makeMode("planning", "Plan")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    assert.strictEqual(result, "planning");
  });

  it("full-access picks bypass permissions mode when present", () => {
    const modes = [
      makeMode("code", "Code"),
      makeMode("bypass", "Bypass Permissions"),
      makeMode("ask", "Ask"),
    ];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
    });
    assert.strictEqual(result, "bypass");
  });

  it("full-access falls back to code mode when no bypass mode exists", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("edits", "Accept Edits")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
    });
    assert.strictEqual(result, "edits");
  });

  it("default picks code/accept-edits mode", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("code", "Code")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, "code");
  });

  it("default picks accept-edits alias", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("edits", "Accept edits")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, "edits");
  });

  it("alias matching is punctuation and case insensitive", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("edits", "Accept Edits!")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, "edits");
  });

  it("returns undefined when nothing matches", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("review", "Review")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, undefined);
  });

  it("plan mode returns undefined when no plan alias matches", () => {
    const modes = [makeMode("code", "Code"), makeMode("ask", "Ask")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    assert.strictEqual(result, undefined);
  });

  it("full-access prefers bypass over code when both are present", () => {
    const modes = [makeMode("code", "Code"), makeMode("bypass", "Bypass Permissions")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
    });
    assert.strictEqual(result, "bypass");
  });

  it("full-access falls back to accept-edits alias", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("edits", "Accept Edits")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
    });
    assert.strictEqual(result, "edits");
  });

  it("plan mode matches by id when id is 'plan'", () => {
    const modes = [makeMode("plan", "Planning Mode")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    assert.strictEqual(result, "plan");
  });

  it("plan mode matches by substring when neither id nor name exactly match", () => {
    const modes = [makeMode("plan-mode", "Planning")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    assert.strictEqual(result, "plan-mode");
  });

  it("default mode matches 'code' by id", () => {
    const modes = [makeMode("code", "Code Mode")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, "code");
  });

  it("default mode matches 'accept-edits' by id with hyphen", () => {
    const modes = [makeMode("accept-edits", "Accept Edits")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "approval-required",
    });
    assert.strictEqual(result, "accept-edits");
  });

  it("full-access returns undefined when neither bypass nor code aliases match", () => {
    const modes = [makeMode("ask", "Ask"), makeMode("review", "Review")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
    });
    assert.strictEqual(result, undefined);
  });

  it("interactionMode plan takes priority over runtimeMode full-access", () => {
    const modes = [makeMode("bypass", "Bypass"), makeMode("plan", "Plan")];
    const result = resolveDevinModeId({
      modes,
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    assert.strictEqual(result, "plan");
  });
});

describe("applyDevinModeSelection", () => {
  it.effect("no-op when resolved mode equals currentModeId", () =>
    Effect.gen(function* () {
      let setModeCalled = false;
      const modes = [makeMode("code", "Code"), makeMode("planning", "Plan")];
      const modeState = makeModeState("planning", modes);
      const runtime = makeMockRuntime({
        modeState,
        onSetMode: () => {
          setModeCalled = true;
        },
      });
      yield* applyDevinModeSelection({
        runtime,
        threadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.strictEqual(setModeCalled, false);
    }),
  );

  it.effect("no-op when getModeState yields undefined", () =>
    Effect.gen(function* () {
      let setModeCalled = false;
      const runtime = makeMockRuntime({
        onSetMode: () => {
          setModeCalled = true;
        },
      });
      yield* applyDevinModeSelection({
        runtime,
        threadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.strictEqual(setModeCalled, false);
    }),
  );

  it.effect("calls setMode for plan interactionMode", () =>
    Effect.gen(function* () {
      const setModes: string[] = [];
      const modes = [makeMode("code", "Code"), makeMode("planning", "Plan")];
      const modeState = makeModeState("code", modes);
      const runtime = makeMockRuntime({
        modeState,
        onSetMode: (id) => {
          setModes.push(id);
        },
      });
      yield* applyDevinModeSelection({
        runtime,
        threadId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.deepStrictEqual(setModes, ["planning"]);
    }),
  );

  it.effect("no-op when resolved mode is undefined", () =>
    Effect.gen(function* () {
      let setModeCalled = false;
      const modes = [makeMode("ask", "Ask"), makeMode("review", "Review")];
      const modeState = makeModeState("ask", modes);
      const runtime = makeMockRuntime({
        modeState,
        onSetMode: () => {
          setModeCalled = true;
        },
      });
      yield* applyDevinModeSelection({
        runtime,
        threadId,
        runtimeMode: "approval-required",
      });
      assert.strictEqual(setModeCalled, false);
    }),
  );

  it.effect("propagates setMode error as ProviderAdapterError", () =>
    Effect.gen(function* () {
      const modes = [makeMode("code", "Code")];
      const modeState = makeModeState("ask", modes);
      const runtime = makeMockRuntime({
        modeState,
        setModeEffect: Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -1,
            errorMessage: "mode change failed",
          }),
        ),
      });
      const error = yield* applyDevinModeSelection({
        runtime,
        threadId,
        runtimeMode: "approval-required",
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterRequestError");
    }),
  );
});
