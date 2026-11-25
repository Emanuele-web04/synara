// Verifies the local record boundary for child ownership and linked profile paths.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readAntigravityChildWork } from "./AntigravityChildWork.ts";

it("ignores other clients' records and rejects a linked inbox in the native profile", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "synara-antigravity-profile-" });
      const sessionId = "aa100000-0000-0000-0000-000000000000";
      const childId = "aa100000-0000-0000-0000-000000000001";
      const metadata = (id: string) =>
        join(root, "antigravity-cli", "brain", id, ".system_generated");
      const children = join(metadata(sessionId), "subagents");
      const messages = join(metadata(childId), "messages");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "synara-antigravity-outside-" });
      const descriptor = JSON.stringify({ conversationId: childId });
      const launch = JSON.stringify({
        sender: sessionId,
        content: "Unrelated profile content",
        sourceMetadata: {
          tool: { conversationId: sessionId, toolCall: { id: "call-a", name: "invoke_subagent" } },
        },
      });
      yield* fs.makeDirectory(children, { recursive: true });
      yield* fs.writeFileString(join(children, `${childId}.json`), descriptor);
      const siblingProfile = join(root, "antigravity-acp", "brain");
      const siblingRecords = join(siblingProfile, sessionId, ".system_generated", "subagents");
      const siblingInbox = join(siblingProfile, childId, ".system_generated", "messages");
      yield* fs.makeDirectory(siblingRecords, { recursive: true });
      yield* fs.makeDirectory(siblingInbox, { recursive: true });
      yield* fs.writeFileString(join(siblingRecords, `${childId}.json`), descriptor);
      yield* fs.writeFileString(join(siblingInbox, "launch.json"), launch);
      const read = readAntigravityChildWork({
        profile: root,
        sessionId,
        toolCallIds: new Set(["call-a"]),
      });
      expect((yield* read)?.children.size).toBe(0);

      yield* fs.writeFileString(join(outside, "launch.json"), launch);
      yield* fs.makeDirectory(metadata(childId), { recursive: true });
      yield* Effect.promise(() =>
        symlink(outside, messages, process.platform === "win32" ? "junction" : "dir"),
      );
      expect(yield* read).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
