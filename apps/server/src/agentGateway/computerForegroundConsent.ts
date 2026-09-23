import type { OrchestrationMessage, ProviderApprovalDecision } from "@synara/contracts";
import { Effect } from "effect";

import type { ComputerApprovalGate } from "../computer/ComputerApprovalGate.ts";
import {
  COMPUTER_FOREGROUND_NOT_AUTHORIZED,
  computerForegroundAuthorizationForMessages,
  type ComputerForegroundAuthorization,
} from "../computer/computerVisibleUse.ts";
import type { AgentGatewayComputerToolsOptions } from "./computerTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

export interface ComputerForegroundConsentOptions {
  readonly gate: Pick<ComputerApprovalGate, "hasForegroundGrant" | "requestForegroundTask">;
  /** The caller thread's messages, or undefined when the thread is gone. */
  readonly loadMessages: (threadId: string) => Promise<readonly OrchestrationMessage[] | undefined>;
  readonly knownAppNames: () => readonly string[];
  /** Publishes the approval card for one prompt and later its resolution. */
  readonly publish: (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => (requestId: string, decision?: ProviderApprovalDecision) => Promise<void>;
}

/**
 * Whether a computer task may bring windows in front of the user. Native apps
 * and browsers share it, and full-access mode alone never answers yes.
 *
 * Two sources count: the user's own words in this task, or their click on the
 * visible-use approval card this turn. The card is asked only when the words
 * did not already answer, and its answer (either way) holds for the turn, so
 * the model can neither word its way past it nor make the user repeat it.
 */
export function makeComputerForegroundConsent(options: ComputerForegroundConsentOptions): {
  readonly resolveForegroundAuthorization: NonNullable<
    AgentGatewayComputerToolsOptions["resolveForegroundAuthorization"]
  >;
  readonly requestForegroundConsent: NonNullable<
    AgentGatewayComputerToolsOptions["requestForegroundConsent"]
  >;
} {
  const resolveForegroundAuthorization = async (
    context: ToolContext,
  ): Promise<ComputerForegroundAuthorization> => {
    if (
      context.callerTurnId !== null &&
      options.gate.hasForegroundGrant(context.callerThreadId, context.callerTurnId)
    ) {
      return { userRequestedVisibleUse: true };
    }
    const messages = await options.loadMessages(context.callerThreadId);
    return messages === undefined
      ? COMPUTER_FOREGROUND_NOT_AUTHORIZED
      : computerForegroundAuthorizationForMessages(messages, {
          knownAppNames: options.knownAppNames(),
        });
  };

  const requestForegroundConsent = async (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (context.callerTurnId === null) return false;
    await Effect.runPromise(context.assertCallerTurnActive(), { signal });
    return options.gate.requestForegroundTask({
      threadId: context.callerThreadId,
      turnId: context.callerTurnId,
      signal,
      publish: options.publish(name, args, context),
    });
  };

  return { resolveForegroundAuthorization, requestForegroundConsent };
}
