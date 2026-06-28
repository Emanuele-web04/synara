/**
 * DevinModeMapper - maps Synara runtime/interaction modes onto the mode list
 * the Devin ACP session advertises at runtime.
 *
 * The session's `availableModes` is the source of truth; the alias tables here
 * are matching heuristics only (Devin may rename/describe modes differently
 * across versions), not a mode catalog.
 *
 * @module DevinModeMapper
 */

import { Effect } from "effect";
import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterError } from "../Errors.ts";
import { mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import type { AcpSessionMode } from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

const PROVIDER = "devin" as const;
const DEVIN_PLAN_MODE_ALIASES = ["plan"];
const DEVIN_FULL_ACCESS_MODE_ALIASES = ["bypass", "bypass permissions"];
const DEVIN_CODE_MODE_ALIASES = ["accept-edits", "code", "accept edits"];

function normalizedModeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function findDevinModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map(normalizedModeText);

  // Exact match on mode.id first (highest confidence).
  for (const mode of modes) {
    const normalizedId = normalizedModeText(mode.id);
    if (normalizedAliases.some((alias) => normalizedId === alias)) return mode;
  }
  // Exact match on mode.name.
  for (const mode of modes) {
    const normalizedName = normalizedModeText(mode.name);
    if (normalizedAliases.some((alias) => normalizedName === alias)) return mode;
  }
  // Substring fallback on id + name only (exclude description to avoid false positives).
  return modes.find((mode) => {
    const haystack = normalizedModeText(`${mode.id} ${mode.name}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

export function resolveDevinModeId(input: {
  readonly modes: ReadonlyArray<AcpSessionMode>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return findDevinModeByAliases(input.modes, DEVIN_PLAN_MODE_ALIASES)?.id;
  }
  if (input.runtimeMode === "full-access") {
    return (
      findDevinModeByAliases(input.modes, DEVIN_FULL_ACCESS_MODE_ALIASES)?.id ??
      findDevinModeByAliases(input.modes, DEVIN_CODE_MODE_ALIASES)?.id
    );
  }
  // approval-required: don't force accept-edits/code mode, which auto-approves
  // file edits. Let Devin use its default (ask) mode for safe approval gating.
  return undefined;
}

export function applyDevinModeSelection(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    if (!modeState) return;
    const modeId = resolveDevinModeId({
      modes: modeState.availableModes,
      runtimeMode: input.runtimeMode,
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    });
    if (!modeId || modeId === modeState.currentModeId) return;
    yield* input.runtime
      .setMode(modeId)
      .pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", error),
        ),
      );
  });
}
