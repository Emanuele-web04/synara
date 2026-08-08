import type { NativeApi, ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { importedThreadTitle, importExternalThread } from "./threadImport";

const PROJECT_ID = "project-1" as ProjectId;

function makeApi(overrides?: {
  dispatchCommand?: (command: { type: string }) => Promise<unknown>;
  importThread?: () => Promise<unknown>;
}) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const dispatchCommand = vi.fn(async (command: { type: string }) => {
    calls.push({ method: "dispatchCommand", payload: command });
    return overrides?.dispatchCommand ? overrides.dispatchCommand(command) : {};
  });
  const importThread = vi.fn(async (input: unknown) => {
    calls.push({ method: "importThread", payload: input });
    return overrides?.importThread ? overrides.importThread() : {};
  });
  const api = {
    orchestration: { dispatchCommand, importThread },
  } as unknown as NativeApi;
  return { api, calls, dispatchCommand, importThread };
}

describe("importedThreadTitle", () => {
  it("prefers the discovered session title over the placeholder", () => {
    expect(
      importedThreadTitle({
        provider: "claudeAgent",
        externalId: "abcd1234-ffff",
        title: "  Fix login flow  ",
      }),
    ).toBe("Fix login flow");
  });

  it("falls back to a provider placeholder with an id suffix", () => {
    expect(importedThreadTitle({ provider: "claudeAgent", externalId: "abcd1234-ffff" })).toBe(
      "Imported Claude session 234-ffff",
    );
    expect(importedThreadTitle({ provider: "codex", externalId: "" })).toBe(
      "Imported Codex thread",
    );
  });
});

describe("importExternalThread", () => {
  const baseInput = {
    projectId: PROJECT_ID,
    provider: "claudeAgent" as const,
    externalId: " session-123 ",
    modelSelection: { provider: "claudeAgent" as const, model: "claude-sonnet-5" },
    envMode: "local" as const,
  };

  it("creates the thread, imports, and returns the new thread id", async () => {
    const { api, calls, dispatchCommand, importThread } = makeApi();

    const threadId = await importExternalThread({ api, ...baseInput });

    expect(calls.map((call) => call.method)).toEqual(["dispatchCommand", "importThread"]);
    const createCommand = dispatchCommand.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createCommand.type).toBe("thread.create");
    expect(createCommand.projectId).toBe(PROJECT_ID);
    expect(createCommand.threadId).toBe(threadId);
    const importInput = importThread.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(importInput.threadId).toBe(threadId);
    expect(importInput.externalId).toBe("session-123");
  });

  it("deletes the created thread and rethrows when the import fails", async () => {
    const { api, dispatchCommand } = makeApi({
      importThread: () => Promise.reject(new Error("session exists, but not for this workspace")),
    });

    await expect(importExternalThread({ api, ...baseInput })).rejects.toThrow(
      "session exists, but not for this workspace",
    );

    const commandTypes = dispatchCommand.mock.calls.map(
      (call) => (call[0] as { type: string }).type,
    );
    expect(commandTypes).toEqual(["thread.create", "thread.delete"]);
  });

  it("does not attempt a delete when thread creation itself fails", async () => {
    const { api, dispatchCommand } = makeApi({
      dispatchCommand: (command) =>
        command.type === "thread.create"
          ? Promise.reject(new Error("create failed"))
          : Promise.resolve({}),
    });

    await expect(importExternalThread({ api, ...baseInput })).rejects.toThrow("create failed");
    expect(dispatchCommand.mock.calls).toHaveLength(1);
  });
});
