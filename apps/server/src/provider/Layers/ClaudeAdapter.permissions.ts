// Purpose: Claude SDK canUseTool permission/user-input flow (approval gating, AskUserQuestion, ExitPlanMode capture).
// Layer: dependency-parameterized factory returning the SDK CanUseTool callback; built once per startSession.
// Exports: ClaudeCanUseToolDeps, makeClaudeCanUseTool.

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Deferred, Effect, Random, Ref } from "effect";

import type { ClaudeEmitters } from "./ClaudeAdapter.emitters.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  extractExitPlanModePlan,
  remapAnswersToClaudeQuestionText,
  summarizeToolRequest,
} from "./ClaudeAdapter.events.ts";
import { PROVIDER } from "./ClaudeAdapter.config.ts";
import {
  type ClaudeEmitterDeps,
  type ClaudeSessionContext,
  nativeProviderRefs,
} from "./ClaudeAdapter.runtime.ts";
import type { PendingApproval, PendingUserInput } from "./ClaudeAdapter.types.ts";

export interface ClaudeCanUseToolDeps {
  readonly contextRef: Ref.Ref<ClaudeSessionContext | undefined>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly offerRuntimeEvent: ClaudeEmitterDeps["offerRuntimeEvent"];
  readonly makeEventStamp: ClaudeEmitterDeps["makeEventStamp"];
  readonly emitProposedPlanCompleted: ClaudeEmitters["emitProposedPlanCompleted"];
}

export function makeClaudeCanUseTool(deps: ClaudeCanUseToolDeps): CanUseTool {
  const {
    contextRef,
    pendingApprovals,
    pendingUserInputs,
    runtimeMode: configuredRuntimeMode,
    offerRuntimeEvent,
    makeEventStamp,
    emitProposedPlanCompleted,
  } = deps;

  /**
   * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
   * runtime event and waiting for the user to respond via `respondToUserInput`.
   */
  const handleAskUserQuestion = (
    context: ClaudeSessionContext,
    toolInput: Record<string, unknown>,
    callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
  ) =>
    Effect.gen(function* () {
      const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

      // Parse questions from the SDK's AskUserQuestion input.
      const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const questions: Array<UserInputQuestion> = rawQuestions.map(
        (q: Record<string, unknown>, idx: number) => ({
          id: typeof q.header === "string" ? q.header : `q-${idx}`,
          header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
          question: typeof q.question === "string" ? q.question : "",
          options: Array.isArray(q.options)
            ? q.options.map((opt: Record<string, unknown>) => ({
                label: typeof opt.label === "string" ? opt.label : "",
                description: typeof opt.description === "string" ? opt.description : "",
              }))
            : [],
          multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
        }),
      );

      const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
      let aborted = false;
      const pendingInput: PendingUserInput = {
        questions,
        answers: answersDeferred,
      };

      // Emit user-input.requested so the UI can present the questions.
      const requestedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.requested",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt: requestedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { questions },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion",
          payload: { toolName: "AskUserQuestion", input: toolInput },
        },
      });

      pendingUserInputs.set(requestId, pendingInput);

      // Handle abort (e.g. turn interrupted while waiting for user input).
      const onAbort = () => {
        if (!pendingUserInputs.has(requestId)) {
          return;
        }
        aborted = true;
        pendingUserInputs.delete(requestId);
        Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
      };
      callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

      // Block until the user provides answers.
      const answers = remapAnswersToClaudeQuestionText(
        questions,
        yield* Deferred.await(answersDeferred).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              callbackOptions.signal.removeEventListener("abort", onAbort);
            }),
          ),
        ),
      );
      pendingUserInputs.delete(requestId);

      // Emit user-input.resolved so the UI knows the interaction completed.
      const resolvedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { answers },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion/resolved",
          payload: { answers },
        },
      });

      if (aborted) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
        } satisfies PermissionResult;
      }

      // Return the answers to the SDK in the expected format:
      // { questions: [...], answers: { questionText: selectedLabel } }
      return {
        behavior: "allow",
        updatedInput: {
          questions: toolInput.questions,
          answers,
        },
      } satisfies PermissionResult;
    });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Ref.get(contextRef);
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        const runtimeMode = configuredRuntimeMode ?? "full-access";
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput);
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        const decision = yield* Deferred.await(decisionDeferred).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              callbackOptions.signal.removeEventListener("abort", onAbort);
            }),
          ),
        );
        pendingApprovals.delete(requestId);

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            decision,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/decision",
            payload: {
              decision,
            },
          },
        });

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "acceptForSession" && pendingApproval.suggestions
              ? { updatedPermissions: [...pendingApproval.suggestions] }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      }),
    );

  return canUseTool;
}
