import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { gatewayIsoNow as isoNow } from "./creationUtils.ts";
import { errorText, readBooleanArg, readStringArg, ToolInputError } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";
import type { CompletionRepository } from "./completionRepository.ts";

/**
 * Fusion (RFC #1301): a "lead" thread carries a FusionPairing (`thread.fusion`)
 * and may delegate bounded tasks to exactly one lazily-created "sidekick"
 * thread. The sidekick lands in the same project + environment (local checkout
 * or the lead's worktree) — it never provisions a second worktree — and its
 * runtimeMode is copied verbatim so it can never out-privilege the lead.
 *
 * Results flow back passively through the existing completion channel:
 * delegate() inserts an `agent_gateway_completions` row, so the lead receives
 * `synara.task.completed` when the sidekick's turn settles.
 */

export const FUSION_SIDEKICK_CREATION_SOURCE = "fusion_sidekick";
export const FUSION_SIDEKICK_ROLE = "sidekick";

/** Sidekicks cannot create threads or delegate further — no fusion recursion. */
export const assertNotFusionSidekick = (caller: {
  readonly creationSource?: string | null | undefined;
}): Effect.Effect<void, ToolInputError> =>
  caller.creationSource === FUSION_SIDEKICK_CREATION_SOURCE
    ? Effect.fail(
        new ToolInputError(
          "Fusion sidekick threads cannot create threads or delegate work. Report results to your lead thread instead.",
        ),
      )
    : Effect.void;

const findSidekick = (
  threads: ReadonlyArray<OrchestrationThread>,
  leadThreadId: string,
): OrchestrationThread | undefined =>
  threads.find(
    (thread) =>
      thread.creationSource === FUSION_SIDEKICK_CREATION_SOURCE &&
      thread.parentThreadId === leadThreadId &&
      thread.deletedAt === null,
  );

const delegatePrompt = (task: string, brief: string): string =>
  `You are the fusion sidekick for the calling lead thread.\n\nBrief:\n${brief}\n\nTask:\n${task}\n\nWhen finished, your result is delivered to the lead automatically. Keep work scoped to the task; report blockers instead of guessing.`;

interface FusionDispatchTarget {
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection?: ModelSelection;
}

interface FusionToolDeps {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly completions: CompletionRepository;
  /** Per-instance provider quota reads; drives auto sidekick pick + retarget. */
  readonly listUsage: () => Effect.Effect<
    ReadonlyArray<ServerProviderUsageSnapshot>,
    ToolInputError
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
  readonly assertCallerMayDriveThread: (
    caller: {
      readonly id?: string;
      readonly runtimeMode: RuntimeMode;
      readonly envMode?: string | null | undefined;
    },
    target: {
      readonly id: string;
      readonly runtimeMode: RuntimeMode;
      readonly envMode?: string | null | undefined;
    },
  ) => Effect.Effect<void, ToolInputError>;
  readonly newId: () => string;
}

/**
 * Quota-aware candidate scoring (RFC #1301 P6). A candidate is *exhausted* when
 * a healthy snapshot reports any window at 100% used. Candidates with no quota
 * data (unsupported provider, missing credentials, failed fetch) rank after
 * healthy ones but stay usable — the RFC degrades to explicit pairing rather
 * than blocking delegation. Returns null only when every candidate provably hit
 * its window.
 */
export const pickFusionSidekick = (
  candidates: ReadonlyArray<ModelSelection>,
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  exclude?: ReadonlySet<string>,
): ModelSelection | null => {
  const snapshotFor = (candidate: ModelSelection) =>
    snapshots.find(
      (snapshot) =>
        snapshot.provider === candidate.provider &&
        (candidate.instanceId === undefined ||
          snapshot.instanceId === undefined ||
          snapshot.instanceId === candidate.instanceId),
    );
  const exhausted = (candidate: ModelSelection) => {
    const snapshot = snapshotFor(candidate);
    if (!snapshot || (snapshot.status ?? "ok") !== "ok") return false;
    return snapshot.limits.some((limit) => (limit.usedPercent ?? 0) >= 100);
  };
  const usedPercent = (candidate: ModelSelection) => {
    const snapshot = snapshotFor(candidate);
    if (!snapshot || (snapshot.status ?? "ok") !== "ok") return null;
    const percents = snapshot.limits.map((limit) => limit.usedPercent ?? 0);
    return percents.length === 0 ? null : Math.max(...percents);
  };
  const eligible = candidates.filter(
    (candidate) => !(exclude?.has(candidate.provider) ?? false) && !exhausted(candidate),
  );
  const known = eligible
    .map((candidate, index) => ({ candidate, index, percent: usedPercent(candidate) }))
    .filter(
      (entry): entry is { candidate: ModelSelection; index: number; percent: number } =>
        entry.percent !== null,
    )
    .toSorted((a, b) => a.percent - b.percent || a.index - b.index);
  return known[0]?.candidate ?? eligible[0] ?? null;
};

/** Poll cap for `wait: true` (~2 minutes at 2s cadence); completions still arrive after it. */
const WAIT_POLL_MAX = 60;
const WAIT_POLL_MS = 2000;

const TERMINAL_TURN_STATES = new Set(["completed", "error", "interrupted", "cancelled"]);

export const makeFusionTools = (deps: FusionToolDeps): ReadonlyArray<ToolEntry> => {
  const {
    snapshotQuery,
    orchestrationEngine,
    completions,
    listUsage,
    requireThreadShell,
    assertCallerMayDriveThread,
    newId,
  } = deps;

  const dispatchTurn = (input: {
    readonly target: FusionDispatchTarget;
    readonly text: string;
    readonly dispatchMode: "queue" | "steer";
    readonly commandTag: string;
  }) => {
    const suffix = newId();
    const messageId = MessageId.makeUnsafe(`fusion:${suffix}:message`);
    return orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`fusion:${suffix}:${input.commandTag}`),
        threadId: input.target.id,
        message: {
          messageId,
          role: "user",
          text: input.text,
          attachments: [],
        },
        dispatchMode: input.dispatchMode,
        dispatchOrigin: "agent",
        runtimeMode: input.target.runtimeMode,
        interactionMode: input.target.interactionMode,
        ...(input.target.modelSelection ? { modelSelection: input.target.modelSelection } : {}),
        createdAt: isoNow(),
      })
      .pipe(
        Effect.map(() => messageId),
        Effect.mapError((error) => new ToolInputError(errorText(error))),
      );
  };

  const createSidekick = (
    lead: OrchestrationThreadShell,
    callerTurnId: string | null,
  ): Effect.Effect<FusionDispatchTarget, ToolInputError> => {
    const pairing = lead.fusion;
    if (!pairing) {
      return Effect.fail(
        new ToolInputError(
          "This thread has no fusion pairing. Enable fusion on the thread (composer /fusion) before delegating.",
        ),
      );
    }
    const suffix = newId();
    const sidekickThreadId = ThreadId.makeUnsafe(`fusion-sidekick:${suffix}`);
    return Effect.gen(function* () {
      // Auto sidekick (RFC #1301 P6): first delegation scores the candidate
      // list against provider quotas and pins the winner on the new thread.
      let sidekickSelection = pairing.sidekick;
      if (pairing.autoSidekick === true && pairing.sidekickCandidates !== undefined) {
        const snapshots = yield* listUsage();
        const picked = pickFusionSidekick(pairing.sidekickCandidates, snapshots);
        if (!picked) {
          return yield* Effect.fail(
            new ToolInputError(
              "Every fusion sidekick candidate is at quota. Retry after a quota window resets.",
            ),
          );
        }
        sidekickSelection = picked;
      }
      return sidekickSelection;
    }).pipe(
      Effect.flatMap((sidekickSelection) =>
        orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`fusion:${suffix}:sidekick-create`),
            threadId: sidekickThreadId,
            projectId: lead.projectId,
            title: `Fusion sidekick · ${lead.title ?? String(lead.id).slice(0, 8)}`,
            modelSelection: sidekickSelection,
            // Sidekick privilege == lead privilege, never higher (RFC #1301).
            runtimeMode: lead.runtimeMode,
            interactionMode: lead.interactionMode,
            envMode: lead.envMode,
            branch: lead.branch,
            worktreePath: lead.worktreePath,
            associatedWorktreePath: lead.associatedWorktreePath,
            associatedWorktreeBranch: lead.associatedWorktreeBranch,
            associatedWorktreeRef: lead.associatedWorktreeRef,
            parentThreadId: lead.id,
            creationSource: FUSION_SIDEKICK_CREATION_SOURCE,
            sourceThreadId: lead.id,
            ...(callerTurnId !== null ? { sourceTurnId: TurnId.makeUnsafe(callerTurnId) } : {}),
            subagentRole: FUSION_SIDEKICK_ROLE,
            fusion:
              pairing.autoSidekick === true ? { ...pairing, sidekick: sidekickSelection } : pairing,
            createdAt: isoNow(),
          })
          .pipe(
            // The projection may lag the committed command; the dispatch only
            // needs the fields we already know from the lead.
            Effect.map(
              (): FusionDispatchTarget => ({
                id: sidekickThreadId,
                runtimeMode: lead.runtimeMode,
                interactionMode: lead.interactionMode,
                modelSelection: sidekickSelection,
              }),
            ),
          ),
      ),
      Effect.mapError((error) => new ToolInputError(errorText(error))),
    );
  };

  const resolveSidekick = (
    lead: OrchestrationThreadShell,
    callerTurnId: string | null,
  ): Effect.Effect<
    { readonly target: FusionDispatchTarget; readonly created: boolean },
    ToolInputError
  > =>
    Effect.gen(function* () {
      const snapshot = yield* snapshotQuery
        .getSnapshot()
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      const existing = findSidekick(snapshot.threads, lead.id);
      if (existing) {
        const shell = yield* requireThreadShell(existing.id);
        return { target: yield* maybeRetarget(lead, shell), created: false };
      }
      return { target: yield* createSidekick(lead, callerTurnId), created: true };
    });

  /**
   * Retargeting (RFC #1301 P6): when the pinned sidekick's provider hits its
   * quota window, re-score the pairing's candidate list and move the sidekick
   * thread's modelSelection to the next candidate with headroom. The lead is
   * told via a `synara.fusion.retargeted` activity; its context is untouched.
   * Provider handoff is the fallback for adapters without model updates — out
   * of scope here: meta.update is durable either way, and adapters that cannot
   * apply it mid-session honor it on the next session start.
   */
  const maybeRetarget = (
    lead: OrchestrationThreadShell,
    sidekick: OrchestrationThreadShell,
  ): Effect.Effect<FusionDispatchTarget, ToolInputError> =>
    Effect.gen(function* () {
      const pairing = lead.fusion;
      const candidates = pairing?.sidekickCandidates;
      const current = sidekick.modelSelection;
      if (pairing?.autoSidekick !== true || !candidates || candidates.length === 0 || !current) {
        return sidekick;
      }
      const snapshots = yield* listUsage();
      // pick() returns null only for a provably exhausted candidate, so a null
      // here is exactly "the pinned provider hit its window" — unknown quota
      // data never triggers a retarget.
      if (pickFusionSidekick([current], snapshots) !== null) return sidekick;
      const next = pickFusionSidekick(candidates, snapshots, new Set([current.provider]));
      if (!next || next.provider === current.provider) return sidekick;
      const stamp = `${String(sidekick.id)}:${next.provider}:${next.model}`;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`fusion-retarget:${stamp}`),
          threadId: sidekick.id,
          modelSelection: next,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`fusion-retarget-activity:${stamp}`),
          threadId: lead.id,
          activity: {
            id: EventId.makeUnsafe(`fusion-retarget:${stamp}`),
            kind: "synara.fusion.retargeted",
            tone: "info",
            summary: `Fusion sidekick retargeted: ${current.provider} → ${next.provider}`,
            payload: {
              reason: "quota window exhausted",
              from: { provider: current.provider, model: current.model },
              to: { provider: next.provider, model: next.model },
            },
            turnId: null,
            createdAt: isoNow(),
          },
          createdAt: isoNow(),
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      return { ...sidekick, modelSelection: next };
    });

  const delegate: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_fusion_delegate",
      description:
        "Delegate a bounded task to this thread's fusion sidekick. The sidekick is created lazily on first use in the same project and environment (never a second worktree) and runs with the same approval mode as this thread. By default the call returns immediately and the sidekick's result arrives later as synara.task.completed; pass wait=true to block briefly for the result. Fusion sidekicks cannot call this tool.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The bounded task for the sidekick to execute.",
          },
          brief: {
            type: "string",
            description:
              "Goal-level or prescriptive context the sidekick needs. Never paste conversation history.",
          },
          wait: {
            type: "boolean",
            description:
              "Block up to ~2 minutes for the sidekick's first result. Default false: return now and receive synara.task.completed.",
          },
        },
        required: ["task", "brief"],
        additionalProperties: false,
      },
      annotations: {
        title: "Delegate to fusion sidekick",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const task = readStringArg(args, "task", { required: true })!;
        const brief = readStringArg(args, "brief", { required: true })!;
        const wait = readBooleanArg(args, "wait") ?? false;
        const lead = yield* requireThreadShell(context.callerThreadId);
        yield* assertNotFusionSidekick(lead);
        const { target: sidekick, created } = yield* resolveSidekick(lead, context.callerTurnId);
        const initialMessageId = yield* dispatchTurn({
          target: sidekick,
          text: delegatePrompt(task, brief),
          dispatchMode: "queue",
          commandTag: "delegate",
        });
        yield* completions
          .enqueue({
            childThreadId: String(sidekick.id),
            creatorThreadId: String(lead.id),
            initialMessageId: String(initialMessageId),
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

        if (!wait) {
          return mcpToolResultJson({
            sidekickThreadId: sidekick.id,
            created,
            status: "running",
            note: "Result arrives as synara.task.completed.",
          });
        }
        // Bounded wait: poll the projection until the initial turn settles.
        for (let i = 0; i < WAIT_POLL_MAX; i++) {
          yield* Effect.sleep(WAIT_POLL_MS);
          const shell = yield* requireThreadShell(sidekick.id);
          const state = shell.latestTurn?.state;
          if (state && TERMINAL_TURN_STATES.has(state)) {
            const detail = Option.getOrUndefined(
              yield* snapshotQuery
                .getThreadDetailById(sidekick.id)
                .pipe(Effect.mapError((error) => new ToolInputError(errorText(error)))),
            );
            const turnId = shell.latestTurn.turnId;
            const lastAssistant = detail?.messages.findLast(
              (m) => m.role === "assistant" && m.turnId === turnId,
            );
            return mcpToolResultJson({
              sidekickThreadId: sidekick.id,
              created,
              status: state,
              result: lastAssistant?.text ?? null,
            });
          }
        }
        return mcpToolResultJson({
          sidekickThreadId: sidekick.id,
          created,
          status: "running",
          note: "Still running after the wait window; result arrives as synara.task.completed.",
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            mcpToolResultError(error instanceof Error ? error.message : String(error)),
          ),
        ),
        Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const feedback: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_fusion_feedback",
      description:
        "Send feedback from this fusion lead thread to its sidekick, steering or queueing the message. Sidekick results arrive through synara.task.completed; sidekicks cannot call this tool. Exchange briefs, results, and feedback only — never conversation history.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Feedback text for the fusion counterpart." },
          mode: {
            type: "string",
            enum: ["queue", "steer"],
            description:
              "queue (default) appends after the current turn; steer interrupts a live turn.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      annotations: {
        title: "Send fusion feedback",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const message = readStringArg(args, "message", { required: true })!;
        const mode = readStringArg(args, "mode") ?? "queue";
        if (mode !== "queue" && mode !== "steer") {
          return yield* Effect.fail(
            new ToolInputError(`Argument "mode" must be "queue" or "steer".`),
          );
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        // RFC #1301: sidekicks are denied every synara_fusion_* tool. They report
        // to the lead through the passive completion delivery instead.
        yield* assertNotFusionSidekick(caller);
        const snapshot = yield* snapshotQuery
          .getSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const sidekick = findSidekick(snapshot.threads, caller.id);
        if (!sidekick) {
          return yield* Effect.fail(
            new ToolInputError("No fusion sidekick exists for this thread. Delegate a task first."),
          );
        }
        const targetId = sidekick.id;
        const target = yield* requireThreadShell(targetId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* dispatchTurn({
          target,
          text: `[fusion feedback]\n${message}`,
          dispatchMode: mode,
          commandTag: "feedback",
        });
        return mcpToolResultJson({ targetThreadId: target.id, dispatched: mode });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            mcpToolResultError(error instanceof Error ? error.message : String(error)),
          ),
        ),
        Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  return [delegate, feedback];
};
