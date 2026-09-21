import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import { makeProjectImportHistoryReader } from "./projectImportHistory";

const { getSessionMessages, readDates } = vi.hoisted(() => ({
  getSessionMessages: vi.fn(async () => []),
  readDates: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../provider/claudeAgentSdk", () => ({
  loadClaudeAgentSdk: async () => ({ getSessionMessages }),
}));
vi.mock("../provider/claudeProjectImport", () => ({ readClaudeImportMessageDates: readDates }));

it("reads the frozen Claude copy from its source project, not the destination workspace", async () => {
  const reader = makeProjectImportHistoryReader({} as ProviderAdapterRegistryShape);
  await Effect.runPromise(
    reader({
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("imported-thread"),
      nativeId: "frozen-copy",
      sourceHome: "/selected-claude-home",
      sourceCwd: "/original-project",
      cwd: "/new-destination",
      sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    }),
  );
  expect(getSessionMessages).toHaveBeenCalledWith("frozen-copy", { dir: "/original-project" });
  expect(readDates).toHaveBeenCalledWith({
    sessionId: "frozen-copy",
    configDir: "/selected-claude-home",
  });
});
