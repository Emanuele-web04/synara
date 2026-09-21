import { collectErrorMessages } from "@synara/shared/errorMessages";
import { MessageId, type ThreadId } from "@synara/contracts";
import {
  ASYNC_USER_INPUT_ALREADY_ANSWERED,
  formatAsyncUserInputResponse,
} from "@synara/shared/asyncUserInput";
import { useCallback } from "react";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
} from "../../threadDetailResumeCursors";

export function useAsyncUserInputResponse(threadId: ThreadId) {
  return useCallback(
    async (messageId: MessageId, answers: readonly string[]) => {
      const api = readNativeApi();
      const thread = getThreadFromState(useStore.getState(), threadId);
      const input = thread?.messages.find((message) => message.id === messageId)?.asyncUserInput;
      if (!api || !thread || !input)
        throw new Error("This question is no longer available. Refresh the conversation.");
      if (input.response) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(randomUUID()),
            role: "user",
            text: formatAsyncUserInputResponse(input.questions, answers),
            attachments: [],
          },
          asyncUserInputResponse: { messageId, answers: [...answers] },
          dispatchMode: "steer",
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        if (
          !collectErrorMessages(error).some((message) =>
            message.includes(ASYNC_USER_INPUT_ALREADY_ANSWERED),
          )
        )
          throw error;
        clearThreadDetailResumeCursor(threadId);
        await api.orchestration.subscribeThread(buildThreadSubscribeInput(threadId));
        return;
      }
      // a competing client may have answered first — refresh the authoritative response; a refresh failure must not turn accepted input into a retry
      clearThreadDetailResumeCursor(threadId);
      void api.orchestration.subscribeThread(buildThreadSubscribeInput(threadId)).catch(() => {});
    },
    [threadId],
  );
}
