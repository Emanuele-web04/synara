// FILE: threadArchive.test.ts
// Purpose: Verifies recognition of the server's already-unarchived invariant.
// Layer: Web lib test
// Exports: Vitest cases for threadArchive helpers

import { ThreadId } from "@synara/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import { assert, describe, it } from "vitest";

import { isThreadAlreadyUnarchivedError } from "./threadArchive";

const THREAD_ID = ThreadId.makeUnsafe("thread-archive");

describe("threadArchive client helpers", () => {
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
