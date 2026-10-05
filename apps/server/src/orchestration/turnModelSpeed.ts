// FILE: turnModelSpeed.ts
// Purpose: Measure each turn's model speed (output tokens ÷ generation time) from
// the provider runtime event stream, so ingestion can stamp it once on the
// turn's `turn.completed` activity for the transcript, the context meter, and
// profile stats to read.
// Layer: server orchestration helper (pure, synchronous; ingestion owns the instance).

import {
  isToolLifecycleItemType,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type TurnModelSpeed,
} from "@synara/contracts";
import {
  modelSpeedTokensPerSecond,
  resolveTurnFastMode,
  type TimeIntervalMs,
  unionDurationMs,
} from "@synara/shared/modelSpeed";
import { getDefaultEffort, getModelCapabilities } from "@synara/shared/model";
import { isProviderKind } from "@synara/shared/providerInstances";

interface CumulativeOutput {
  readonly provider: string;
  readonly sessionKey: string;
  readonly outputTokens: number;
  // Output of the request that produced this snapshot, when the provider says.
  readonly lastOutputTokens?: number | undefined;
}

/** The thread's model selection when the turn started (its persisted choice). */
export interface TurnModelSelectionHint {
  readonly model?: string | undefined;
  readonly fastMode?: boolean | undefined;
  readonly effort?: string | undefined;
}

/**
 * The thread's selection is updated when the turn is requested, so at
 * turn.started it is this turn's model, fast mode, and effort. Without an
 * explicit effort the model's default applies, the one the composer picker
 * shows (e.g. Claude Opus at "high"); unknown models have none.
 */
export function turnModelSelectionHint(
  modelSelection: ModelSelection | undefined,
): TurnModelSelectionHint | undefined {
  if (!modelSelection) return undefined;
  const options = asRecord((modelSelection as { readonly options?: unknown }).options);
  const effort =
    typeof options?.reasoningEffort === "string"
      ? options.reasoningEffort
      : typeof options?.effort === "string"
        ? options.effort
        : getDefaultEffort(getModelCapabilities(modelSelection.provider, modelSelection.model));
  return {
    model: modelSelection.model,
    ...(typeof options?.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
    ...(effort ? { effort } : {}),
  };
}

interface OpenTurn {
  readonly turnId: string;
  readonly provider: string;
  // Provider-reported model for the turn (rerouted model when it changes),
  // falling back to the thread's selection.
  model?: string | undefined;
  readonly selectedFastMode?: boolean | undefined;
  readonly effort?: string | undefined;
  readonly startedAtMs: number;
  // Last cumulative counter seen before the turn started.
  readonly baseline?: CumulativeOutput | undefined;
  firstInTurn?: CumulativeOutput | undefined;
  latestInTurn?: CumulativeOutput | undefined;
  // Time the model was not generating: tool execution and pending requests.
  readonly excluded: TimeIntervalMs[];
  readonly openTools: Map<string, number>;
  readonly openRequests: Map<string, number>;
}

export interface TurnModelSpeedObservation {
  // Settled speed of a completed turn (on its turn.completed event), or the
  // running figure while the turn is live (on a token-usage snapshot).
  readonly live: boolean;
  readonly speed: TurnModelSpeed;
}

interface ThreadState {
  openTurn?: OpenTurn | undefined;
  lastCumulative?: CumulativeOutput | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sessionKeyOf(event: ProviderRuntimeEvent): string {
  return `${event.providerRefs?.providerThreadId ?? ""}:${event.lifecycleGeneration ?? ""}`;
}

/**
 * The provider's running output-token counter carried by a token-usage
 * snapshot, or undefined when the provider does not report one.
 *
 * - Codex: `cumulativeUsage.outputTokens` is the thread's `total_token_usage`;
 *   `lastOutputTokens` is only the latest model request, so a turn with several
 *   requests needs the counter's delta. OpenAI output tokens include reasoning.
 *   Subagent (collab) threads report their own usage, which the Codex manager
 *   drops before it reaches this thread.
 * - Pi: `outputTokens` is the session's running total (`getSessionStats`).
 * - Claude is measured from its turn result instead (see claudeTurnOutputTokens):
 *   its per-message snapshots carry the streaming-start output count, not the
 *   final one. OpenCode and the ACP providers report no turn-attributable output
 *   counter (per-message/step snapshots without ids, or context size only), so
 *   their turns are not measured rather than risk double counting.
 */
function cumulativeOutputFromSnapshot(
  event: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>,
): CumulativeOutput | undefined {
  const usage = event.payload.usage;
  const outputTokens =
    event.provider === "codex"
      ? usage.cumulativeUsage?.outputTokens
      : event.provider === "pi"
        ? usage.outputTokens
        : undefined;
  if (outputTokens === undefined) return undefined;
  return {
    provider: event.provider,
    sessionKey: sessionKeyOf(event),
    outputTokens,
    lastOutputTokens: event.provider === "codex" ? usage.lastOutputTokens : undefined,
  };
}

/**
 * Claude's SDK result `usage` sums the final usage of every main-loop API
 * response in the turn; reasoning (thinking) tokens are part of output_tokens.
 * Subagent and background-task output is deliberately excluded: it only
 * appears in the result's `modelUsage`, and the time it ran is tool time here,
 * so counting it would report impossible rates.
 */
function claudeTurnOutputTokens(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
): number | undefined {
  return nonNegativeNumber(asRecord(event.payload.usage)?.output_tokens);
}

function cumulativeDelta(turn: OpenTurn): number | undefined {
  const latest = turn.latestInTurn;
  if (!latest) return undefined;
  const baseline = turn.baseline;
  if (
    baseline &&
    baseline.sessionKey === latest.sessionKey &&
    baseline.outputTokens <= latest.outputTokens
  ) {
    return latest.outputTokens - baseline.outputTokens;
  }
  // No usable pre-turn counter (first turn, restarted session): the first
  // in-turn snapshot already includes its own request's output.
  const first = turn.firstInTurn;
  if (
    first?.lastOutputTokens !== undefined &&
    first.sessionKey === latest.sessionKey &&
    first.outputTokens - first.lastOutputTokens >= 0 &&
    first.outputTokens <= latest.outputTokens
  ) {
    return latest.outputTokens - (first.outputTokens - first.lastOutputTokens);
  }
  return undefined;
}

function toolResultPresent(event: ProviderRuntimeEvent): boolean {
  if (event.type !== "item.updated") return false;
  return asRecord(event.payload.data)?.result !== undefined;
}

export class TurnModelSpeedTracker {
  private readonly threads = new Map<string, ThreadState>();

  /**
   * Feeds one runtime event of `threadId`. Returns the settled turn's speed on
   * its `turn.completed` event, and the live figure so far on each token-usage
   * snapshot of the running turn, when the turn can be measured.
   */
  observe(
    threadId: string,
    event: ProviderRuntimeEvent,
    selection?: TurnModelSelectionHint,
  ): TurnModelSpeedObservation | undefined {
    const atMs = Date.parse(event.createdAt);
    if (!Number.isFinite(atMs)) return undefined;
    const state = this.threads.get(threadId) ?? {};
    const turn = state.openTurn;
    const inOpenTurn =
      turn !== undefined && (event.turnId === undefined || event.turnId === turn.turnId);

    switch (event.type) {
      case "turn.started": {
        if (event.turnId === undefined) break;
        const baseline =
          state.lastCumulative?.provider === event.provider ? state.lastCumulative : undefined;
        const model = event.payload.model ?? selection?.model;
        const effort = event.payload.effort ?? selection?.effort;
        state.openTurn = {
          turnId: event.turnId,
          provider: event.provider,
          ...(model ? { model } : {}),
          ...(selection?.fastMode !== undefined ? { selectedFastMode: selection.fastMode } : {}),
          ...(effort ? { effort } : {}),
          startedAtMs: atMs,
          ...(baseline ? { baseline } : {}),
          excluded: [],
          openTools: new Map(),
          openRequests: new Map(),
        };
        this.threads.set(threadId, state);
        return undefined;
      }
      case "turn.completed": {
        if (!turn || !inOpenTurn) return undefined;
        state.openTurn = undefined;
        // Interrupted and failed turns stop mid-generation or never report
        // final usage; their rate would be misleading.
        if (event.payload.state !== "completed" || event.provider !== turn.provider) {
          return undefined;
        }
        const outputTokens =
          turn.provider === "claudeAgent" ? claudeTurnOutputTokens(event) : cumulativeDelta(turn);
        const speed = measureTurnModelSpeed(turn, atMs, outputTokens);
        return speed ? { live: false, speed } : undefined;
      }
      case "model.rerouted": {
        if (turn && inOpenTurn) turn.model = event.payload.toModel;
        return undefined;
      }
      case "turn.aborted": {
        if (inOpenTurn) state.openTurn = undefined;
        return undefined;
      }
      case "session.exited": {
        this.threads.delete(threadId);
        return undefined;
      }
      case "thread.token-usage.updated": {
        const cumulative = cumulativeOutputFromSnapshot(event);
        if (cumulative) {
          state.lastCumulative = cumulative;
          this.threads.set(threadId, state);
        }
        if (!turn || !inOpenTurn || event.provider !== turn.provider) return undefined;
        if (cumulative) {
          turn.firstInTurn ??= cumulative;
          turn.latestInTurn = cumulative;
        }
        // Live figure: the same measurement as the settled one, with the
        // output so far and still-open tools/requests counted up to now.
        const outputTokens =
          turn.provider === "claudeAgent"
            ? event.payload.usage.turnOutputTokens
            : cumulative
              ? cumulativeDelta(turn)
              : undefined;
        const speed = measureTurnModelSpeed(turn, atMs, outputTokens);
        return speed ? { live: true, speed } : undefined;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!turn || !inOpenTurn || event.itemId === undefined) return undefined;
        if (!isToolLifecycleItemType(event.payload.itemType)) return undefined;
        const itemId = String(event.itemId);
        if (event.type === "item.completed") {
          const startMs = turn.openTools.get(itemId);
          if (startMs !== undefined) {
            turn.excluded.push({ startMs, endMs: atMs });
            turn.openTools.delete(itemId);
          }
          return undefined;
        }
        // Claude opens a tool item when the model starts writing its input and
        // republishes it while that input streams; that is generation time.
        // Execution starts after the last input update, so move the start
        // there. Other providers open tool items once the call is issued.
        if (
          event.provider === "claudeAgent" &&
          turn.openTools.has(itemId) &&
          !toolResultPresent(event)
        ) {
          turn.openTools.set(itemId, atMs);
        } else if (!turn.openTools.has(itemId)) {
          turn.openTools.set(itemId, atMs);
        }
        return undefined;
      }
      case "request.opened":
      case "user-input.requested": {
        if (!turn || !inOpenTurn || event.requestId === undefined) return undefined;
        const key = `${event.type === "request.opened" ? "approval" : "input"}:${event.requestId}`;
        if (!turn.openRequests.has(key)) turn.openRequests.set(key, atMs);
        return undefined;
      }
      case "request.resolved":
      case "user-input.resolved": {
        if (!turn || event.requestId === undefined) return undefined;
        const key = `${event.type === "request.resolved" ? "approval" : "input"}:${event.requestId}`;
        const startMs = turn.openRequests.get(key);
        if (startMs !== undefined) {
          turn.excluded.push({ startMs, endMs: atMs });
          turn.openRequests.delete(key);
        }
        return undefined;
      }
      default:
        return undefined;
    }
    return undefined;
  }

  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
  }
}

/**
 * Measures `turn` up to `atMs`: generation time is the turn's wall time minus
 * the union of tool executions (commands, file changes, MCP/dynamic tools, web
 * search, subagent calls) and pending approvals/user input; anything still
 * open counts up to `atMs`. Claude's `duration_api_ms` is not used: the SDK
 * reports it for the whole process (subagents and side requests included), so
 * it does not isolate this turn's main loop.
 */
export function measureTurnModelSpeed(
  turn: Pick<
    OpenTurn,
    | "provider"
    | "model"
    | "selectedFastMode"
    | "effort"
    | "startedAtMs"
    | "excluded"
    | "openTools"
    | "openRequests"
  >,
  atMs: number,
  outputTokens: number | undefined,
): TurnModelSpeed | undefined {
  if (outputTokens === undefined) return undefined;
  const excluded = [
    ...turn.excluded,
    ...[...turn.openTools.values(), ...turn.openRequests.values()].map((startMs) => ({
      startMs,
      endMs: atMs,
    })),
  ];
  const generationMs = Math.round(
    atMs - turn.startedAtMs - unionDurationMs(excluded, turn.startedAtMs, atMs),
  );
  const roundedOutputTokens = Math.round(outputTokens);
  if (modelSpeedTokensPerSecond(roundedOutputTokens, generationMs) === null) return undefined;
  return {
    outputTokens: roundedOutputTokens,
    generationMs,
    ...(isProviderKind(turn.provider) ? { provider: turn.provider } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    fastMode: resolveTurnFastMode({ model: turn.model, selectedFastMode: turn.selectedFastMode }),
    ...(turn.effort ? { effort: turn.effort } : {}),
  };
}
