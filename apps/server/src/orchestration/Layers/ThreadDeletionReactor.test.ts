import { ThreadId } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupSucceededUnlessInterrupted,
  closeThreadTerminalScopes,
  isThreadCurrentlyArchived,
} from "./ThreadDeletionReactor";
import { TerminalError } from "../../terminal/Services/Manager";

describe("terminal scope cleanup", () => {
  it("closes dock terminals even when the host terminal close fails", async () => {
    const close = vi.fn(() => Effect.void as Effect.Effect<void, TerminalError>);
    close.mockReturnValueOnce(Effect.fail(new TerminalError({ message: "host close failed" })));
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore: () => Effect.void },
        ThreadId.makeUnsafe("host"),
        true,
      ),
    );
    expect(result).toBe(false);
    expect(close.mock.calls).toEqual([
      [{ threadId: "host", deleteHistory: true }],
      [{ threadId: "dock-terminal:host", deleteHistory: true }],
    ]);
  });

  it("preserves the archive generation fence for both terminal scopes", async () => {
    const close = vi.fn(() => Effect.void);
    const closeSessionsOpenedAtOrBefore = vi.fn(() => Effect.void);
    const archivedAt = "2026-09-09T12:00:00.000Z";
    const result = await Effect.runPromise(
      closeThreadTerminalScopes(
        { close, closeSessionsOpenedAtOrBefore },
        ThreadId.makeUnsafe("host"),
        false,
        archivedAt,
      ),
    );
    expect(result).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeSessionsOpenedAtOrBefore.mock.calls).toEqual([
      [{ threadId: "host", openedAtOrBefore: archivedAt }],
      [{ threadId: "dock-terminal:host", openedAtOrBefore: archivedAt }],
    ]);
  });
});

describe("isThreadCurrentlyArchived", () => {
  it("rejects stale archive cleanup after an undo has cleared archivedAt", () => {
    expect(isThreadCurrentlyArchived({ archivedAt: null })).toBe(false);
    expect(isThreadCurrentlyArchived(undefined)).toBe(false);
    expect(isThreadCurrentlyArchived({ archivedAt: "2026-07-23T20:00:00.000Z" })).toBe(true);
  });
});

describe("cleanupSucceededUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
