import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
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

/** Poll cap for `wait: true` (~2 minutes at 2s cadence); completions still arrive after it. */
const WAIT_POLL_MAX = 60;
const WAIT_POLL_MS = 2000;

const TERMINAL_TURN_STATES = new Set(["completed", "error", "interrupted", "cancelled"]);

export const makeFusionTools = (deps: FusionToolDeps): ReadonlyArray<ToolEntry> => {
  const {
    snapshotQuery,
    orchestrationEngine,
    completions,
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
    return orchestrationEngine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`fusion:${suffix}:sidekick-create`),
        threadId: sidekickThreadId,
        projectId: lead.projectId,
        title: `Fusion sidekick · ${lead.title ?? String(lead.id).slice(0, 8)}`,
        modelSelection: pairing.sidekick,
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
        fusion: pairing,
        createdAt: isoNow(),
      })
      .pipe(
        // The projection may lag the committed command; the dispatch only needs
        // the fields we already know from the lead.
        Effect.map(
          (): FusionDispatchTarget => ({
            id: sidekickThreadId,
            runtimeMode: lead.runtimeMode,
            interactionMode: lead.interactionMode,
            modelSelection: pairing.sidekick,
          }),
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
        return { target: shell, created: false };
      }
      return { target: yield* createSidekick(lead, callerTurnId), created: true };
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
