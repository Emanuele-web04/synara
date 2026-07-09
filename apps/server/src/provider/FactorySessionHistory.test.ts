// FILE: FactorySessionHistory.test.ts
// Purpose: Verifies Factory JSONL imports exclude hidden context and preserve visible messages.
// Layer: Provider persistence compatibility tests
// Depends on: FactorySessionHistory and temporary filesystem fixtures.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { readFactorySessionHistory } from "./FactorySessionHistory.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("reads only user-visible Droid session messages", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-factory-session-"));
  tempDirs.push(homeDir);
  const sessionDir = path.join(homeDir, ".factory", "sessions", "-tmp-project");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "session-1.jsonl"),
    [
      { type: "session_start", id: "session-1", cwd: "/tmp/project" },
      {
        type: "message",
        id: "hidden",
        message: {
          role: "user",
          visibility: "llm_only",
          content: [{ type: "text", text: "hidden" }],
        },
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-07-08T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Question" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );

  await expect(readFactorySessionHistory(homeDir, "session-1")).resolves.toEqual({
    sessionId: "session-1",
    cwd: "/tmp/project",
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "Question",
        timestamp: "2026-07-08T00:00:00.000Z",
      },
      { id: "assistant-1", role: "assistant", text: "Answer" },
    ],
  });
});
