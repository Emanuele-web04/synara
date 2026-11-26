import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { restoreClaudeImportedCopyDates } from "./claudeImportedCopyDates.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("restoreClaudeImportedCopyDates", () => {
  it.each([true, false])(
    "uses native fork provenance to restore dates without changing source or custom-title metadata (SDK timestamps: %s)",
    async (sdkTimestamp) => {
      const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-copy-dates-"));
      directories.push(configDir);
      const projectDir = path.join(configDir, "projects", "project");
      await mkdir(projectDir, { recursive: true });
      const sourceSessionId = randomUUID();
      const copiedSessionId = randomUUID();
      const sourceUuid = randomUUID();
      const sourceMessages = [
        {
          type: "assistant",
          uuid: sourceUuid,
          session_id: sourceSessionId,
          message: { role: "assistant", content: "Done" },
          parent_tool_use_id: null,
          parent_agent_id: null,
          timestamp: "2026-09-01T10:00:02.000Z",
        },
      ] satisfies ReadonlyArray<SessionMessage & { timestamp: string }>;
      const sourceFile = path.join(projectDir, `${sourceSessionId}.jsonl`);
      const copyFile = path.join(projectDir, `${copiedSessionId}.jsonl`);
      const sourceText =
        JSON.stringify({
          type: "assistant",
          sessionId: sourceSessionId,
          uuid: sourceUuid,
          timestamp: "2026-09-01T10:00:02.000Z",
        }) + "\n";
      await writeFile(sourceFile, sourceText);
      const title = {
        type: "custom-title",
        customTitle: "Imported",
        timestamp: "2026-09-16T10:00:00.000Z",
      };
      await writeFile(
        copyFile,
        [
          {
            type: "assistant",
            uuid: randomUUID(),
            sessionId: copiedSessionId,
            message: sourceMessages[0]!.message,
            forkedFrom: { sessionId: sourceSessionId, messageUuid: sourceUuid },
            timestamp: "2026-09-16T10:00:00.000Z",
          },
          title,
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await restoreClaudeImportedCopyDates({
        sourceSessionId,
        copiedSessionId,
        sourceMessages: sdkTimestamp
          ? sourceMessages
          : sourceMessages.map(({ timestamp: _timestamp, ...message }) => message),
        configDir,
      });
      const copied = (await readFile(copyFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(copied[0].timestamp).toBe(sourceMessages[0]!.timestamp);
      expect(copied[1]).toEqual(title);
      expect(await readFile(sourceFile, "utf8")).toBe(sourceText);
    },
  );

  it("restores a queued-command attachment date through the preserved source_uuid link", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-copy-dates-"));
    directories.push(configDir);
    const projectDir = path.join(configDir, "projects", "project");
    await mkdir(projectDir, { recursive: true });
    const sourceSessionId = randomUUID();
    const copiedSessionId = randomUUID();
    const assistantUuid = randomUUID();
    const attachmentUuid = randomUUID();
    // The SDK keys the materialized queued-command message by source_uuid,
    // which names no transcript entry of its own.
    const queuedSourceUuid = randomUUID();
    const assistantTimestamp = "2026-09-01T10:00:02.000Z";
    const queuedTimestamp = "2026-09-01T10:05:00.000Z";
    const forkTimestamp = "2026-09-16T10:00:00.000Z";
    const sourceFile = path.join(projectDir, `${sourceSessionId}.jsonl`);
    const copyFile = path.join(projectDir, `${copiedSessionId}.jsonl`);
    await writeFile(
      sourceFile,
      [
        {
          type: "assistant",
          uuid: assistantUuid,
          sessionId: sourceSessionId,
          timestamp: assistantTimestamp,
          message: { role: "assistant", content: "Done" },
        },
        {
          type: "attachment",
          uuid: attachmentUuid,
          sessionId: sourceSessionId,
          parentUuid: assistantUuid,
          timestamp: queuedTimestamp,
          attachment: {
            type: "queued_command",
            commandMode: "prompt",
            prompt: "also check the tests",
            source_uuid: queuedSourceUuid,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const title = {
      type: "custom-title",
      customTitle: "Imported",
      timestamp: forkTimestamp,
    };
    await writeFile(
      copyFile,
      [
        {
          type: "assistant",
          uuid: randomUUID(),
          sessionId: copiedSessionId,
          forkedFrom: { sessionId: sourceSessionId, messageUuid: assistantUuid },
          timestamp: forkTimestamp,
          message: { role: "assistant", content: "Done" },
        },
        {
          type: "attachment",
          uuid: randomUUID(),
          sessionId: copiedSessionId,
          forkedFrom: { sessionId: sourceSessionId, messageUuid: attachmentUuid },
          timestamp: forkTimestamp,
          attachment: {
            type: "queued_command",
            commandMode: "prompt",
            prompt: "also check the tests",
            source_uuid: queuedSourceUuid,
          },
        },
        title,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const sourceMessages = [
      {
        type: "assistant",
        uuid: assistantUuid,
        session_id: sourceSessionId,
        message: { role: "assistant", content: "Done" },
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: assistantTimestamp,
      },
      {
        type: "user",
        uuid: queuedSourceUuid,
        session_id: sourceSessionId,
        message: { role: "user", content: "also check the tests" },
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: queuedTimestamp,
        isQueuedCommand: true,
      },
    ] satisfies ReadonlyArray<SessionMessage & { timestamp: string; isQueuedCommand?: boolean }>;
    await restoreClaudeImportedCopyDates({
      sourceSessionId,
      copiedSessionId,
      sourceMessages,
      configDir,
    });
    const copied = (await readFile(copyFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(copied[0].timestamp).toBe(assistantTimestamp);
    expect(copied[1].timestamp).toBe(queuedTimestamp);
    expect(copied[1].attachment.source_uuid).toBe(queuedSourceUuid);
    expect(copied[2]).toEqual(title);
    expect(await readFile(sourceFile, "utf8")).toContain(queuedTimestamp);
  });

  it("does not write when the copy lacks matching native provenance", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-copy-dates-"));
    directories.push(configDir);
    const projectDir = path.join(configDir, "projects", "project");
    await mkdir(projectDir, { recursive: true });
    const copiedSessionId = randomUUID();
    const sourceSessionId = randomUUID();
    const copyFile = path.join(projectDir, `${copiedSessionId}.jsonl`);
    const before = JSON.stringify({
      type: "assistant",
      sessionId: copiedSessionId,
      timestamp: "2026-09-16T10:00:00.000Z",
    });
    await writeFile(copyFile, before);
    const sourceMessages = [
      {
        type: "assistant",
        uuid: randomUUID(),
        session_id: sourceSessionId,
        message: {},
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: "2026-09-01T10:00:00.000Z",
      },
    ] satisfies ReadonlyArray<SessionMessage & { timestamp: string }>;
    await expect(
      restoreClaudeImportedCopyDates({
        copiedSessionId,
        sourceSessionId,
        sourceMessages,
        configDir,
      }),
    ).rejects.toThrow("provenance");
    expect(await readFile(copyFile, "utf8")).toBe(before);
  });
});
