// Owns collision and deletion regressions for thread-scoped visual documents.
// Exercises real disk writes through inlineVisualStore.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  inlineVisualThreadDirectory,
  readInlineVisual,
  writeInlineVisual,
} from "./inlineVisualStore";

it("deleting one thread never removes another thread's similarly normalized visual directory", async () => {
  const attachmentsDir = await mkdtemp(path.join(tmpdir(), "visual-ownership-"));
  const visualId = `vis_${"a".repeat(32)}`;
  try {
    for (const threadId of ["foo/bar", "foo-bar"]) {
      await writeInlineVisual({ attachmentsDir, threadId, visualId, html: threadId });
    }
    await rm(inlineVisualThreadDirectory({ attachmentsDir, threadId: "foo/bar" })!, {
      recursive: true,
    });
    expect(await readInlineVisual({ attachmentsDir, threadId: "foo-bar", visualId })).toBe(
      "foo-bar",
    );
  } finally {
    await rm(attachmentsDir, { recursive: true, force: true });
  }
});
