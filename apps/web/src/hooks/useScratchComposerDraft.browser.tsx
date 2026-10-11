import { ThreadId } from "@synara/contracts";
import { flushSync } from "react-dom";
import { beforeEach, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { AppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useScratchComposerDraft } from "./useScratchComposerDraft";

beforeEach(() => resetComposerDraftStore());

it("keeps custom provider instances distinct while restoring and changing a scratch model", async () => {
  const settings = {
    codexAccounts: [],
    codexHomePath: "",
    selectedCodexAccountId: "default",
    providerInstances: {
      codex_work: { driver: "codex", displayName: "Work", enabled: true },
      codex_personal: { driver: "codex", displayName: "Personal", enabled: true },
    },
  } satisfies Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "selectedCodexAccountId" | "providerInstances"
  >;
  useComposerDraftStore
    .getState()
    .setModelSelectionAndSticky(ThreadId.makeUnsafe("previous-chat"), {
      provider: "codex",
      instanceId: "codex_work",
      model: "gpt-5.4",
      options: { reasoningEffort: "high" },
    });
  const hook = await renderHook(() =>
    useScratchComposerDraft({ defaultProvider: "claudeAgent", settings }),
  );
  try {
    expect(hook.result.current).toMatchObject({
      selectedProvider: "codex",
      selectedProviderInstanceId: "codex_work",
      selectedModel: "gpt-5.4",
      selectedProviderModelOptions: { reasoningEffort: "high" },
    });
    flushSync(() =>
      hook.result.current.handleProviderModelChange("codex", "gpt-5.4-mini", "codex_personal"),
    );
    expect(hook.result.current).toMatchObject({
      selectedProvider: "codex",
      selectedProviderInstanceId: "codex_personal",
      selectedModel: "gpt-5.4-mini",
    });
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_work?.model).toBe(
      "gpt-5.4",
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.codex_personal?.model,
    ).toBe("gpt-5.4-mini");
  } finally {
    await hook.unmount();
  }
});
