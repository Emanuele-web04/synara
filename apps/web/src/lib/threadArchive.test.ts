// FILE: threadArchive.test.ts
// Purpose: Verifies client helpers for archive/unarchive orchestration commands.
// Layer: Web lib test
// Exports: Vitest cases for threadArchive helpers

import { ThreadId } from "@synara/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import { assert, describe, expect, it, vi } from "vitest";

import {
  archiveThreadFromClient,
  isThreadAlreadyUnarchivedError,
  unarchiveThreadFromClient,
} from "./threadArchive";

const THREAD_ID = ThreadId.makeUnsafe("thread-archive");

describe("threadArchive client helpers", () => {
  it("dispatches archive and unarchive commands", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    const api = { dispatchCommand };

    await archiveThreadFromClient(api, THREAD_ID);
    await unarchiveThreadFromClient(api, THREAD_ID);

    expect(dispatchCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "thread.archive",
        threadId: THREAD_ID,
      }),
    );
    expect(dispatchCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "thread.unarchive",
        threadId: THREAD_ID,
      }),
    );
  });

  it("recognizes the already-unarchived invariant returned by the server", () => {
    // Build the message from the shared marker so this stays coupled to the
    // exact phrase the server embeds (see commandInvariants.requireThreadArchived).
    const error = new Error(
      `Orchestration command invariant failed (thread.unarchive): Thread '${THREAD_ID}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} 'thread.unarchive'.`,
    );

    assert.equal(isThreadAlreadyUnarchivedError(error, THREAD_ID), true);
  });

  it("does not treat unrelated invariant errors as already restored", () => {
    const error = new Error(
      "Orchestration command invariant failed (thread.archive): Thread 'thread-archive' is already archived and cannot handle command 'thread.archive'.",
    );

    assert.equal(isThreadAlreadyUnarchivedError(error, THREAD_ID), false);
  });
});
