import { ProjectId, ThreadId, TodoId, type Todo, type TodoUpdateInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { ScratchModelCatalog } from "../../hooks/useScratchModelCatalog";
import type { DraftThreadDispatchResult } from "../../lib/draftThreadDispatch";
import { makeThread } from "../../storeTestFixtures";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { useTaskCanUnlink } from "./taskDelegationState";
import { useTaskDelegation } from "./useTaskDelegation";

const transport = vi.hoisted(() => ({ dispatch: vi.fn(), list: vi.fn() }));
const notifications = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ todo: { list: transport.list } }),
  readNativeApi: () => undefined,
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => {},
}));
vi.mock("../ui/toast", () => ({ toastManager: notifications }));
beforeEach(() => {
  transport.dispatch.mockReset();
  transport.list.mockReset();
  notifications.add.mockClear();
  resetComposerDraftStore();
});
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
    pendingBackgroundWorkCount: 0,
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
    await hook.result.current.delegation.handleStart();
    expect(transport.dispatch).toHaveBeenCalledTimes(1);
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

it.each(
  (["new", "existing"] as const).flatMap((destination) =>
    (
      [
        "unconfirmed",
        "confirmed",
        "accepted",
        "not-linked",
        "rejected",
        "unlink-unconfirmed",
        "unlink-retained",
        "unlink-confirmed",
        "edited-start-failure",
        "persisted-start-failure",
        "edited-link",
      ] as const
    )
      .map((outcome) => ({ destination, outcome }))
      .filter(({ outcome }) => outcome !== "edited-link" || destination === "existing"),
  ),
)(
  "handles $outcome link outcomes for a $destination chat without duplicate dispatch",
  async ({ destination, outcome }) => {
    const client = new QueryClient();
    const now = new Date();
    const existing = {
      ...makeThread({ id: ThreadId.makeUnsafe(`link-recovery-${destination}`) }),
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasLiveTailWork: false,
      pendingBackgroundWorkCount: 0,
    };
    let todo: Todo = {
      id: TodoId.makeUnsafe(`unknown-link-${destination}-${outcome}`),
      title: "Keep my task",
      notes: "Keep my notes",
      priority: "none",
      projectId: null,
      dueDate: null,
      threadId: null,
      delegationBaseTurnId: null,
      linkedAt: null,
      completedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const interrupted = Object.assign(new Error("Reply lost"), {
      _tag: "WsTransportRequestInterruptedError",
      code: "WS_REQUEST_RECONNECTED",
    });
    let claimedThread: ThreadId | null = null;
    transport.list.mockImplementation(async () => {
      if (outcome === "confirmed") return { todos: [todo] };
      if (outcome === "unlink-retained") return { todos: [{ ...todo, threadId: claimedThread }] };
      if (outcome === "not-linked") return { todos: [] };
      throw new Error("Still offline");
    });
    const failsStart =
      outcome === "unlink-unconfirmed" ||
      outcome === "unlink-retained" ||
      outcome === "unlink-confirmed" ||
      outcome === "edited-start-failure" ||
      outcome === "persisted-start-failure";
    transport.dispatch.mockImplementation(async () => {
      if (outcome === "persisted-start-failure")
        useComposerDraftStore.getState().clearPersistedAttachments(claimedThread!);
      if (outcome === "edited-start-failure") {
        // A user types in the open chat while its dispatch request is pending.
        useComposerDraftStore.getState().setPrompt(claimedThread!, "My next message");
      }
      return failsStart ? { kind: "error", message: "Start refused" } : { kind: "dispatched" };
    });
    let releaseLink: (() => void) | undefined;
    const onLinkChat = vi.fn(async (input: TodoUpdateInput) => {
      if (input.threadId) claimedThread = input.threadId;
      if (outcome === "edited-link" && input.threadId) {
        await new Promise<void>((resolve) => {
          releaseLink = resolve;
        });
      }
      todo = { ...todo, threadId: input.threadId ?? null, linkedAt: now.toISOString() };
      if (
        outcome === "accepted" ||
        outcome === "edited-link" ||
        outcome === "unlink-confirmed" ||
        outcome === "edited-start-failure" ||
        outcome === "persisted-start-failure" ||
        ((outcome === "unlink-unconfirmed" || outcome === "unlink-retained") &&
          input.threadId !== null)
      )
        return;
      if (outcome === "rejected") throw new Error("Link refused");
      throw interrupted;
    });
    const hook = await renderHook(
      () => ({
        delegation: useTaskDelegation({
          todo,
          readPrompt: () => "Keep my task\n\nKeep my notes",
          onLinkChat,
          onDelegated: undefined,
          draft: {
            scratchThreadId: ThreadId.makeUnsafe(`scratch-${destination}`),
            prompt: "Keep my task\n\nKeep my notes",
            setPrompt: () => {},
            selectedProvider: "codex",
            selectedProviderInstanceId: "codex",
            selectedModel: "gpt-5.4",
            selectedModelSupportsAutoMode: undefined,
            selectedProviderModelOptions: undefined,
            handleProviderModelChange: () => {},
          },
          catalog: {
            modelOptionsByProvider: { codex: [] },
            runtimeMode: "approval-required",
            runtimeModelForCapabilities: undefined,
          } as unknown as ScratchModelCatalog,
          providerStatuses: [
            {
              provider: "codex",
              driver: "codex",
              instanceId: "codex",
              status: "ready",
              available: true,
              authStatus: "authenticated",
              checkedAt: now.toISOString(),
            },
          ],
          target: { kind: "project", projectId: ProjectId.makeUnsafe("project-recovery") },
          existingChat: destination === "existing" ? existing : null,
        }),
        canUnlink: useTaskCanUnlink(todo, "starting", now),
      }),
      {
        wrapper: ({ children }: { children?: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      const pending = hook.result.current.delegation.handleStart();
      if (outcome === "edited-link") {
        await vi.waitFor(() => expect(releaseLink).toBeDefined());
        useComposerDraftStore.getState().setPrompt(claimedThread!, "My next message");
        releaseLink!();
      }
      await pending;
      await hook.rerender();
      // A matching existing-chat link may belong to another window whose winning
      // CAS reply was received. The losing window's interrupted reply proves nothing.
      const dispatched =
        outcome === "accepted" || (outcome === "confirmed" && destination === "new") || failsStart;
      expect(transport.dispatch).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(onLinkChat).toHaveBeenCalledTimes(failsStart || outcome === "edited-link" ? 2 : 1);
      if (outcome === "unlink-unconfirmed" || outcome === "unlink-retained") {
        // Reconciliation may restore a link whose rollback reply was lost.
        todo = { ...todo, threadId: claimedThread };
        await hook.rerender();
      }
      const uncertain =
        (outcome === "unconfirmed" && destination === "new") || outcome === "unlink-unconfirmed";
      expect(hook.result.current.canUnlink).toBe(uncertain);
      if (
        uncertain ||
        outcome === "not-linked" ||
        (destination === "existing" && (outcome === "confirmed" || outcome === "unconfirmed"))
      ) {
        expect(notifications.add).toHaveBeenCalledWith(
          expect.objectContaining({ type: "warning" }),
        );
      }
      if (outcome === "unlink-retained") {
        expect(notifications.add).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Couldn't unlink the task" }),
        );
      }
      if (outcome === "edited-start-failure" || outcome === "edited-link") {
        expect(useComposerDraftStore.getState().draftsByThreadId[claimedThread!]?.prompt).toBe(
          "My next message",
        );
      }
      if (destination === "new") {
        const draft = useComposerDraftStore.getState().getDraftThread(claimedThread!);
        if (
          outcome === "unconfirmed" ||
          outcome === "confirmed" ||
          outcome === "accepted" ||
          outcome === "unlink-unconfirmed" ||
          outcome === "unlink-retained" ||
          outcome === "edited-start-failure"
        ) {
          expect(draft).toBeTruthy();
          expect(useComposerDraftStore.getState().draftsByThreadId[claimedThread!]?.prompt).toBe(
            outcome === "edited-start-failure"
              ? "My next message"
              : "Keep my task\n\nKeep my notes",
          );
        } else {
          expect(draft).toBeNull();
        }
      }
    } finally {
      releaseLink?.();
      await hook.unmount();
      client.clear();
      resetComposerDraftStore();
    }
  },
);
