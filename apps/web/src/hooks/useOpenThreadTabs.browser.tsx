import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import {
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
} from "../test/browserHarness";
import { useOpenThreadTabs } from "./useOpenThreadTabs";

afterEach(() => {
  resetComposerDraftStore();
  useOpenThreadTabsStore.setState({ threadIds: [] });
  useStore.setState(initialState);
  localStorage.clear();
});

it("labels a draft tab with its selected account's provider instead of its instance id", async () => {
  localStorage.clear();
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  resetComposerDraftStore();
  useStore.setState(initialState);
  const threadId = ThreadId.makeUnsafe("custom-account-draft");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(ProjectId.makeUnsafe("project"), threadId, {});
  useComposerDraftStore.getState().setModelSelectionAndSticky(threadId, {
    provider: "codex",
    instanceId: "codex_work",
    model: "gpt-5.4",
  });
  useOpenThreadTabsStore.setState({ threadIds: [threadId] });
  const queryClient = new QueryClient();
  const at = "2026-09-30T00:00:00.000Z";
  queryClient.setQueryData(serverQueryKeys.config(), createBrowserTestServerConfig(at));
  queryClient.setQueryData(serverQueryKeys.settings(), createBrowserTestServerSettings(at));
  const hook = await renderHook(() => useOpenThreadTabs({ activeThreadId: threadId }), {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  try {
    expect(hook.result.current).toEqual([
      expect.objectContaining({ threadId, provider: "codex", isDraft: true }),
    ]);
  } finally {
    await hook.unmount();
    queryClient.clear();
  }
});
