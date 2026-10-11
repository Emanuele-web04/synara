import {
  ThreadId,
  type ProviderModelDescriptor,
  type ServerProviderStatus,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { Thread } from "../../types";
import { useChatRuntimeModes } from "./useChatRuntimeModes";

const { dispatchCommand } = vi.hoisted(() => ({ dispatchCommand: vi.fn(async () => {}) }));
vi.mock("../../nativeApi", async (original) => ({
  ...(await original<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({ orchestration: { dispatchCommand } }),
}));

afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

const threadId = ThreadId.makeUnsafe("hub-worker-auto");
const modelSelection = { provider: "codex", model: "gpt-6.1-sol" } as const;
const thread = { id: threadId, modelSelection } as Thread;
const status: ServerProviderStatus = {
  provider: "codex",
  driver: "codex",
  instanceId: "codex",
  available: true,
  status: "ready",
  authStatus: "authenticated",
  supportsAutoRuntimeMode: true,
  checkedAt: new Date(0).toISOString(),
};

function Harness({
  providerStatus,
  runtimeModel,
  persisted = false,
}: {
  providerStatus: ServerProviderStatus | null;
  runtimeModel?: ProviderModelDescriptor;
  persisted?: boolean;
}) {
  const selectedModelSelection =
    providerStatus?.provider === "claudeAgent"
      ? { provider: "claudeAgent" as const, model: "claude-test", supportsAutoMode: true }
      : modelSelection;
  useChatRuntimeModes({
    threadId,
    activeThread: thread,
    serverThread: persisted ? thread : undefined,
    isLocalDraftThread: false,
    runtimeMode: "auto",
    onRuntimeModePersisted: vi.fn(),
    interactionMode: "default",
    selectedProvider: selectedModelSelection.provider,
    selectedRuntimeModel: runtimeModel,
    selectedModelSelection,
    activeProviderStatus: providerStatus,
    scheduleComposerFocus: vi.fn(),
  });
  return null;
}

it("keeps the chosen Auto mode while provider capabilities load or reconnect", async () => {
  useComposerDraftStore.getState().setRuntimeMode(threadId, "auto");
  const mounted = await render(<Harness providerStatus={null} />);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
  await mounted.rerender(<Harness providerStatus={status} />);
  await mounted.rerender(<Harness providerStatus={null} />);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
});

it("does not persist a stricter mode for an existing Hub worker before discovery arrives", async () => {
  const mounted = await render(<Harness providerStatus={null} persisted />);
  expect(dispatchCommand).not.toHaveBeenCalled();
  await mounted.rerender(<Harness providerStatus={status} persisted />);
  expect(dispatchCommand).not.toHaveBeenCalled();
  await mounted.rerender(
    <Harness providerStatus={{ ...status, supportsAutoRuntimeMode: false }} persisted />,
  );
  await vi.waitFor(() =>
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.runtime-mode.set",
        threadId,
        runtimeMode: "approval-required",
      }),
    ),
  );
});

it("keeps Claude Auto while model metadata loads, but respects explicit model incompatibility", async () => {
  const claudeStatus = {
    ...status,
    provider: "claudeAgent",
    driver: "claudeAgent",
    instanceId: "claudeAgent",
  } as const;
  useComposerDraftStore.getState().setRuntimeMode(threadId, "auto");
  const mounted = await render(<Harness providerStatus={claudeStatus} />);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
  await mounted.rerender(
    <Harness
      providerStatus={claudeStatus}
      runtimeModel={{ slug: "claude-test", name: "Claude Test", supportsAutoMode: false }}
    />,
  );
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    ),
  );
});

it("still falls back when the provider explicitly reports Auto is unsupported", async () => {
  useComposerDraftStore.getState().setRuntimeMode(threadId, "auto");
  await render(<Harness providerStatus={{ ...status, supportsAutoRuntimeMode: false }} />);
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    ),
  );
});
