import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readClaudeSessionMessagePageInEnvironment } from "./importThreadRoute";

it("pages the SDK-selected Claude chain in an isolated account without transferring huge tool results", async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), "synara-claude-history-page-"));
  try {
    const sessionId = randomUUID();
    const project = path.join(configDir, "projects", "fixture");
    await mkdir(project, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 26; i += 1) {
      const uuid = randomUUID();
      rows.push({
        type: i % 2 ? "assistant" : "user",
        uuid,
        parentUuid: parent,
        sessionId,
        isSidechain: false,
        message: {
          role: i % 2 ? "assistant" : "user",
          content: [{ type: "text", text: `Message ${i}` }],
        },
        timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
      });
      parent = uuid;
    }
    const toolId = randomUUID();
    rows.push({
      type: "user",
      uuid: toolId,
      parentUuid: parent,
      sessionId,
      isSidechain: false,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool", content: "x".repeat(17 * 1024 * 1024) },
        ],
      },
    });
    const file = path.join(project, `${sessionId}.jsonl`);
    const original = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(file, original);
    const input = {
      sessionId,
      dir: undefined,
      environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    };
    const recent = await readClaudeSessionMessagePageInEnvironment(input);
    expect(recent.messages).toHaveLength(20);
    expect(recent.messages[0]?.message).toEqual({ content: "Message 6" });
    expect(recent.messages.at(-1)?.message).toEqual({ content: "Message 25" });
    expect(Buffer.byteLength(JSON.stringify(recent))).toBeLessThan(16_000);
    // A concurrent continuation cannot shift an ID-based older-page boundary.
    rows.push({
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: toolId,
      sessionId,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "New continuation" }] },
    });
    const continued = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(file, continued);
    const older = await readClaudeSessionMessagePageInEnvironment({
      ...input,
      before: recent.nextCursor!,
    });
    expect(older.messages.map((message) => message.message)).toEqual(
      Array.from({ length: 6 }, (_, i) => ({ content: `Message ${i}` })),
    );
    expect(older.nextCursor).toBeNull();
    expect(await readFile(file, "utf8")).toBe(continued);
    await expect(
      readClaudeSessionMessagePageInEnvironment({ ...input, before: "missing-boundary" }),
    ).rejects.toThrow("boundary");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
