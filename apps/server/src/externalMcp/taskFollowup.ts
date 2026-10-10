import { createHash, randomUUID } from "node:crypto";

import { CommandId, MessageId, type ExternalMcpSendTaskMessageInput } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";

import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ExternalMcpRepositoryShape } from "./Services/ExternalMcpRepository.ts";
import type {
  ExternalMcpServiceShape,
  ExternalMcpVerifiedClient,
} from "./Services/ExternalMcpService.ts";

const RUN_PREFIX = "mcp_run_";
export const isExternalMcpFollowupRunId = (runId: string | null): runId is string =>
  runId?.startsWith(RUN_PREFIX) === true;

export const requireExternalMcpFollowupRun = Effect.fn(function* (input: {
  readonly repository: ExternalMcpRepositoryShape;
  readonly integrationId: string;
  readonly threadId: string;
  readonly runId: string;
}) {
  const run = yield* input.repository.getFollowupRun(input);
  if (run === null) {
    return yield* Effect.fail(
      new GatewayToolError(
        "run_not_found",
        "This follow-up run does not belong to this integration and task.",
      ),
    );
  }
  return run;
});

export function makeSendTaskMessageHandler(deps: {
  readonly repository: ExternalMcpRepositoryShape;
  readonly service: ExternalMcpServiceShape;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
}) {
  return (
    input: ExternalMcpSendTaskMessageInput,
    client: ExternalMcpVerifiedClient,
    assertActive: () => Effect.Effect<void, GatewayToolError>,
  ) => {
    const candidateRunId = `${RUN_PREFIX}${randomUUID()}`;
    let reservationAttempted = false;
    return Effect.gen(function* () {
      yield* assertActive();
      const integrationId = client.integration.integrationId;
      const mode = input.mode ?? "queue";
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ threadId: input.threadId, message: input.message, mode }))
        .digest("hex");
      const previous = yield* deps.repository.getFollowupByRequest({
        integrationId,
        requestId: input.requestId,
      });
      if (previous !== null && previous.fingerprint !== fingerprint) {
        return yield* Effect.fail(
          new GatewayToolError(
            "idempotency_conflict",
            "This requestId already identifies a different follow-up.",
          ),
        );
      }
      let followup = previous;
      if (followup === null) {
        const authorized = yield* deps.service.assertTaskWrite(client, input.threadId);
        reservationAttempted = true;
        const reservation = yield* deps.repository.reserveFollowup({
          runId: candidateRunId,
          integrationId,
          requestId: input.requestId,
          fingerprint,
          taskOperationId: authorized.precondition.gatewayOperationId,
          threadId: input.threadId,
          messageId: `mcp_message_${randomUUID()}`,
          commandId: `mcp_followup_${randomUUID()}`,
          mode,
          createdAt: new Date().toISOString(),
        });
        if (reservation.kind === "inactive") {
          return yield* Effect.fail(
            new GatewayToolError(
              "external_credential_inactive",
              "The integration is no longer active.",
            ),
          );
        }
        if (reservation.kind === "task_denied") {
          return yield* Effect.fail(
            new GatewayToolError(
              "task_denied",
              "Only successfully created owned tasks accept follow-ups.",
            ),
          );
        }
        if (reservation.kind === "concurrency_limited") {
          return yield* Effect.fail(
            new GatewayToolError(
              "concurrency_limited",
              "This integration has reached its active task limit.",
              {
                activeCount: reservation.activeCount,
                limit: reservation.limit,
              },
            ),
          );
        }
        if (reservation.kind === "idempotency_conflict") {
          return yield* Effect.fail(
            new GatewayToolError(
              "idempotency_conflict",
              "This requestId already identifies a different follow-up.",
            ),
          );
        }
        followup = reservation.followup;
        if (reservation.kind === "reserved") {
          const admitted = reservation.followup;
          // Persist the attempt before submitting it. On interruption, record the
          // outcome while finalizers are masked; never replay an uncertain send.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              let dispatchAttempted = false;
              const outcome = yield* restore(
                Effect.gen(function* () {
                  yield* assertActive();
                  if (!(yield* deps.repository.markFollowupDispatching(admitted.runId))) {
                    return yield* Effect.fail(
                      new GatewayToolError(
                        "dispatch_not_attempted",
                        "The follow-up could not be admitted.",
                      ),
                    );
                  }
                  yield* assertActive();
                  dispatchAttempted = true;
                  return yield* deps.orchestrationEngine.dispatch({
                    type: "thread.turn.start",
                    commandId: CommandId.makeUnsafe(admitted.commandId),
                    threadId: input.threadId,
                    message: {
                      messageId: MessageId.makeUnsafe(admitted.messageId),
                      role: "user",
                      text: input.message,
                      attachments: [],
                    },
                    dispatchMode: admitted.mode,
                    dispatchOrigin: "agent",
                    runtimeMode: authorized.thread.runtimeMode,
                    interactionMode: authorized.thread.interactionMode,
                    taskWritePrecondition: authorized.precondition,
                    createdAt: admitted.createdAt,
                  });
                }),
              ).pipe(Effect.exit);
              if (Exit.isFailure(outcome))
                yield* deps.repository.failReservedFollowup(admitted.runId);
              yield* deps.repository.settleFollowupDispatch({
                runId: admitted.runId,
                accepted: Exit.isSuccess(outcome),
                notAttempted: !dispatchAttempted,
              });
              if (Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause)) {
                return yield* Effect.failCause(outcome.cause);
              }
            }),
          );
        }
      }
      const run = yield* requireExternalMcpFollowupRun({
        repository: deps.repository,
        integrationId,
        threadId: input.threadId,
        runId: followup.runId,
      });
      yield* assertActive();
      return {
        ...run,
        mode: followup.mode,
        terminal: run.state === "completed" || run.state === "error" || run.state === "interrupted",
        waitTask: {
          tool: "synara_wait_for_task",
          arguments: { threadId: input.threadId, runId: run.runId },
        },
      };
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          reservationAttempted
            ? deps.repository.failReservedFollowup(candidateRunId).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning(
                    "Could not release an unattempted external MCP follow-up reservation.",
                    {
                      runId: candidateRunId,
                      cause,
                    },
                  ),
                ),
              )
            : Effect.void,
        ),
      ),
    );
  };
}
