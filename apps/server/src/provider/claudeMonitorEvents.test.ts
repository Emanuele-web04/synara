import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem } from "effect";

import {
  makeClaudeMonitorEventCursor,
  parseClaudeMonitorEventNotification,
  readClaudeMonitorEvents,
} from "./claudeMonitorEvents.ts";

const SESSION_ID = "a77129eb-d5c5-4fb7-b76f-a535378bad2b";

// Shapes mirror a real Claude Code 2.1.295 transcript.
const MONITOR_EVENT = [
  "<task-notification>",
  "<task-id>bu336ro2k</task-id>",
  '<summary>Monitor event: "CI checks on PR #1699"</summary>',
  "<event>Collect PR targets: pass",
  "Detect code changes: pass</event>",
  "</task-notification>",
].join("\n");
const MONITOR_ENDED = [
  "<task-notification>",
  "<task-id>bu336ro2k</task-id>",
  "<tool-use-id>toolu_01TncQ6seE8bLsYLJSR1626P</tool-use-id>",
  "<status>completed</status>",
  '<summary>Monitor "CI checks on PR #1699" stream ended</summary>',
  "<event>ALL DONE</event>",
  "</task-notification>",
].join("\n");
const COMMAND_COMPLETED = [
  "<task-notification>",
  "<task-id>bg3ny9wty</task-id>",
  "<status>completed</status>",
  '<summary>Background command "Wait for CI" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");

function notificationLine(uuid: string, timestamp: string, content: string, extra = {}): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp,
    isSidechain: false,
    origin: { kind: "task-notification", producer: "session-task" },
    message: { role: "user", content },
    ...extra,
  });
}

describe("parseClaudeMonitorEventNotification", () => {
  it("reads the monitor name and event lines", () => {
    expect(parseClaudeMonitorEventNotification(MONITOR_EVENT)).toEqual({
      taskId: "bu336ro2k",
      name: "CI checks on PR #1699",
      output: "Collect PR targets: pass\nDetect code changes: pass",
      outcome: "updated",
      message: "CI checks on PR #1699 — Collect PR targets: pass · Detect code changes: pass",
    });
    expect(parseClaudeMonitorEventNotification(MONITOR_ENDED)).toEqual({
      taskId: "bu336ro2k",
      name: "CI checks on PR #1699",
      output: "ALL DONE",
      outcome: "completed",
      message: "CI checks on PR #1699 stream ended — ALL DONE",
    });
  });

  it("distinguishes a failed Monitor from an intermediate update without flattening its output", () => {
    const failed = MONITOR_ENDED.replace("completed", "failed").replace(
      "ALL DONE",
      "first line\nsecond line",
    );
    expect(parseClaudeMonitorEventNotification(failed)).toMatchObject({
      name: "CI checks on PR #1699",
      outcome: "failed",
      output: "first line\nsecond line",
    });
    expect(parseClaudeMonitorEventNotification(MONITOR_EVENT)).toMatchObject({
      outcome: "updated",
    });
  });

  it("ignores notifications without monitor event lines", () => {
    expect(parseClaudeMonitorEventNotification(COMMAND_COMPLETED)).toBeUndefined();
    expect(parseClaudeMonitorEventNotification("plain prompt")).toBeUndefined();
  });
});

describe("readClaudeMonitorEvents", () => {
  const withConfigDir = <A>(
    run: (transcript: string, configDir: string, fs: FileSystem.FileSystem) => Effect.Effect<A>,
  ) => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-monitor-events-"));
    const projectDir = path.join(configDir, "projects", "-tmp-work");
    mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* run(transcript, configDir, fileSystem);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(configDir, { recursive: true, force: true }))),
      Effect.runPromise,
    );
  };

  it("returns each new monitor event once, skipping earlier and unrelated entries", () =>
    withConfigDir((transcript, configDir, fileSystem) =>
      Effect.gen(function* () {
        writeFileSync(
          transcript,
          [
            notificationLine("before-session", "2026-10-09T15:00:00.000Z", MONITOR_EVENT),
            notificationLine("command", "2026-10-09T15:03:00.000Z", COMMAND_COMPLETED),
            notificationLine("sidechain", "2026-10-09T15:03:01.000Z", MONITOR_EVENT, {
              isSidechain: true,
            }),
            JSON.stringify({ type: "user", uuid: "human", message: { content: MONITOR_EVENT } }),
            notificationLine("event-1", "2026-10-09T15:03:38.414Z", MONITOR_EVENT),
            "",
          ].join("\n"),
        );
        const cursor = makeClaudeMonitorEventCursor();
        const input = { sessionId: SESSION_ID, configDir, notBefore: "2026-10-09T15:01:00.000Z" };

        expect(yield* readClaudeMonitorEvents(fileSystem, cursor, input)).toEqual([
          {
            id: "event-1",
            createdAt: "2026-10-09T15:03:38.414Z",
            taskId: "bu336ro2k",
            name: "CI checks on PR #1699",
            output: "Collect PR targets: pass\nDetect code changes: pass",
            outcome: "updated",
            message: "CI checks on PR #1699 — Collect PR targets: pass · Detect code changes: pass",
          },
        ]);
        expect(yield* readClaudeMonitorEvents(fileSystem, cursor, input)).toEqual([]);

        // A partially written line waits for its newline.
        const ended = notificationLine("event-2", "2026-10-09T15:12:06.840Z", MONITOR_ENDED);
        appendFileSync(transcript, ended.slice(0, 40));
        expect(yield* readClaudeMonitorEvents(fileSystem, cursor, input)).toEqual([]);
        appendFileSync(transcript, `${ended.slice(40)}\n`);
        expect(
          (yield* readClaudeMonitorEvents(fileSystem, cursor, input)).map((event) => event.id),
        ).toEqual(["event-2"]);
      }),
    ));

  it("yields nothing when the transcript is missing", () =>
    withConfigDir((_transcript, configDir, fileSystem) =>
      Effect.gen(function* () {
        const events = yield* readClaudeMonitorEvents(fileSystem, makeClaudeMonitorEventCursor(), {
          sessionId: SESSION_ID,
          configDir,
          notBefore: "2026-10-09T15:01:00.000Z",
        });
        expect(events).toEqual([]);
      }),
    ));
});
