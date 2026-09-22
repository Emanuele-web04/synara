// FILE: OmpSessionHistory.test.ts
// Purpose: Verifies OMP JSONL session imports keep visible messages and session metadata.
// Layer: Provider persistence compatibility tests
// Depends on: OmpSessionHistory and temporary filesystem fixtures.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { readOmpSessionHistory } from "./OmpSessionHistory.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("reads visible OMP session messages and the last-used model", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-omp-agent-"));
  tempDirs.push(agentDir);
  const sessionDir = path.join(agentDir, "sessions", "-tmp-project");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "2026-09-22T08-00-00-000Z_sess-abc.jsonl"),
    [
      { type: "session", id: "sess-abc", cwd: "/tmp/project", version: "3" },
      { type: "model_change", model: "opencode-go/deepseek-v4-flash" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-09-22T08:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<synara_host_context>workspace /tmp/project</synara_host_context>hello there",
            },
          ],
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-09-22T08:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "hi" },
            { type: "text", text: "there" },
          ],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-09-22T08:00:03.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output not shown" }],
          timestamp: 3,
        },
      },
      { type: "model_change", model: "opencode-go/muse-spark-1.3-contributor" },
      { type: "thinking_level_change", thinkingLevel: "xhigh" },
      { type: "custom", customType: "tool_execution_end", data: {} },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );

  const history = await readOmpSessionHistory(agentDir, "sess-abc");

  expect(history).toEqual({
    sessionId: "sess-abc",
    cwd: "/tmp/project",
    lastModel: "opencode-go/muse-spark-1.3-contributor",
    lastThinkingLevel: "xhigh",
    messages: [
      {
        id: "u1",
        role: "user",
        text: "hello there",
        timestamp: "2026-09-22T08:00:01.000Z",
      },
      {
        id: "a1",
        role: "assistant",
        text: "hi\n\nthere",
        timestamp: "2026-09-22T08:00:02.000Z",
      },
    ],
  });
});

it("returns null when the session id does not match a session file", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-omp-agent-"));
  tempDirs.push(agentDir);
  const sessionDir = path.join(agentDir, "sessions", "-tmp-project");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "2026-09-22T08-00-00-000Z_sess-abc.jsonl"),
    JSON.stringify({ type: "session", id: "sess-abc", cwd: "/tmp/project" }),
  );

  await expect(readOmpSessionHistory(agentDir, "sess-other")).resolves.toBeNull();
});

it("rejects session ids that could traverse outside the sessions directory", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-omp-agent-"));
  tempDirs.push(agentDir);

  await expect(readOmpSessionHistory(agentDir, "../escape")).resolves.toBeNull();
});
