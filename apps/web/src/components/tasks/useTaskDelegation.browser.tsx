import { ThreadId, TodoId, type Todo } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { ScratchModelCatalog } from "../../hooks/useScratchModelCatalog";
import type { DraftThreadDispatchResult } from "../../lib/draftThreadDispatch";
import { makeThread } from "../../storeTestFixtures";
import { useTaskCanUnlink } from "./taskDelegationState";
import { useTaskDelegation } from "./useTaskDelegation";

const transport = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock("../../lib/draftThreadDispatch", async (original) => ({
  ...(await original<typeof import("../../lib/draftThreadDispatch")>()),
  dispatchDraftThread: transport.dispatch,
}));

it("blocks unlink throughout an in-flight start and restores recovery when its response is lost", async () => {
  const client = new QueryClient();
  const thread = {
    ...makeThread({ id: ThreadId.makeUnsafe("uncertain-start-chat") }),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
  };
  const now = new Date();
  const todo: Todo = {
    id: TodoId.makeUnsafe("uncertain-start-task"),
    title: "Start task",
    notes: "",
    priority: "none",
    projectId: null,
    dueDate: null,
    threadId: thread.id,
    delegationBaseTurnId: null,
    linkedAt: now.toISOString(),
    completedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  let resolveDispatch!: (result: DraftThreadDispatchResult) => void;
  transport.dispatch.mockImplementation(
    () =>
      new Promise<DraftThreadDispatchResult>((resolve) => {
        resolveDispatch = resolve;
      }),
  );
  let prompt = "";
  const hook = await renderHook(
    () => ({
      delegation: useTaskDelegation({
        todo,
        readPrompt: () => prompt,
        onLinkChat: async () => undefined,
        onDelegated: undefined,
        draft: {
          scratchThreadId: ThreadId.makeUnsafe("recovery-scratch"),
          prompt: "Start task",
          setPrompt: () => {},
          selectedProvider: "codex",
          selectedProviderInstanceId: "codex",
          selectedModel: null,
          selectedModelSupportsAutoMode: undefined,
          selectedProviderModelOptions: undefined,
          handleProviderModelChange: () => {},
        },
        // The existing-chat path never uses the new-chat model picker/catalog.
        catalog: {
          modelOptionsByProvider: {},
          runtimeMode: "approval-required",
          runtimeModelForCapabilities: undefined,
        } as ScratchModelCatalog,
        providerStatuses: [],
        target: null,
        existingChat: thread,
      }),
      freshCanUnlink: useTaskCanUnlink(todo, "starting", now),
      oldCanUnlink: useTaskCanUnlink(todo, "starting", new Date(now.getTime() + 120_000)),
    }),
    {
      wrapper: ({ children }: { children?: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  let pending: Promise<void> | undefined;
  try {
    expect(hook.result.current.freshCanUnlink).toBe(false);
    await hook.result.current.delegation.handleStart();
    expect(transport.dispatch).not.toHaveBeenCalled();
    prompt = "Latest edited task title and note";
    pending = hook.result.current.delegation.handleStart();
    await vi.waitFor(() => expect(transport.dispatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hook.result.current.oldCanUnlink).toBe(false));
    resolveDispatch({ kind: "error", outcomeUnknown: true, message: "Reply lost" });
    await pending;
    await vi.waitFor(() => expect(hook.result.current.freshCanUnlink).toBe(true));
  } finally {
    resolveDispatch?.({ kind: "error", outcomeUnknown: true, message: "Reply lost" });
    await pending;
    await hook.unmount();
    client.clear();
  }
});
