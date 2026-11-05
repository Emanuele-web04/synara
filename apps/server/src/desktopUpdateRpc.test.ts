// Purpose: Ensures resource leases and ordinary clients cannot restart the desktop owner.
// Layer: Server RPC admission tests, including busy and failed idleness reads.
import { Effect } from "effect";
import { ThreadId, TurnId, type ProviderSession } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestDesktopUpdate } from "./desktopUpdateBridge";
import {
  authorizeRemoteDesktopUpdateSession,
  desktopUpdateAuthorityForSession,
  hasDesktopUpdateThreadWork,
  hasDesktopUpdateProviderWork,
  makeDesktopUpdateRpcHandlers,
} from "./desktopUpdateRpc";
import { provideWsConnectionSession } from "./wsConnectionSessions";

vi.mock("./desktopUpdateBridge", () => ({
  desktopUpdateBridgeAvailable: () => true,
  requestDesktopUpdate: vi.fn(async () => ({
    accepted: true,
    status: { supported: true, state: null, busy: false, message: null },
  })),
}));

beforeEach(() => {
  vi.mocked(requestDesktopUpdate).mockClear();
});

describe("desktop updater RPC authorization", () => {
  it.each([
    { status: "running" as const, activeTurnId: TurnId.makeUnsafe("retained-turn") },
    { status: "closed" as const, activeTurnId: TurnId.makeUnsafe("retained-turn") },
    { status: "closed" as const },
  ])("waits for retained process cleanup (session=$status)", async (retainedState) => {
    const threadId = ThreadId.makeUnsafe("retained-owner");
    let retained: readonly ProviderSession[] = [
      {
        provider: "pi",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
        ...retainedState,
      },
    ];
    const handlers = makeDesktopUpdateRpcHandlers(
      hasDesktopUpdateProviderWork(
        [],
        [],
        () => Effect.succeed(false),
        () => Effect.sync(() => retained),
      ),
    );
    const install = () =>
      Effect.runPromise(
        provideWsConnectionSession(
          handlers.action({
            action: "install",
            expectedVersion: "1.0.1-remote.1",
            confirmRestart: true,
            restartToken: "received-token",
          }),
          {
            role: "owner",
            attachmentPrincipal: { ownerKind: "session", ownerId: "owner" },
            desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
          },
        ),
      );
    expect(await install()).toMatchObject({ accepted: false, status: { busy: true } });
    expect(
      vi.mocked(requestDesktopUpdate).mock.calls.some(([request]) => request.action === "install"),
    ).toBe(false);

    retained = [];
    expect(await install()).toMatchObject({ accepted: true, status: { busy: false } });
    expect(
      vi.mocked(requestDesktopUpdate).mock.calls.some(([request]) => request.action === "install"),
    ).toBe(true);
  });

  it("refuses restart when retained process ownership cannot be read", async () => {
    const readBusy = hasDesktopUpdateProviderWork(
      [],
      [],
      () => Effect.succeed(false),
      () => Effect.die(new Error("retained ownership unavailable")),
    );
    const handlers = makeDesktopUpdateRpcHandlers(readBusy);
    const result = await Effect.runPromise(
      provideWsConnectionSession(
        handlers.action({
          action: "install",
          expectedVersion: "1.0.1-remote.1",
          confirmRestart: true,
          restartToken: "received-token",
        }),
        {
          role: "owner",
          attachmentPrincipal: { ownerKind: "session", ownerId: "owner" },
          desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
        },
      ),
    );
    expect(result).toMatchObject({ accepted: false, status: { busy: true } });
    expect(
      vi.mocked(requestDesktopUpdate).mock.calls.some(([request]) => request.action === "install"),
    ).toBe(false);
  });

  it("refuses restart for a ready provider whose foreground turn ended but background work is live", async () => {
    const threadId = ThreadId.makeUnsafe("background-owner");
    const readBusy = hasDesktopUpdateProviderWork([{ threadId, status: "ready" }], [threadId], () =>
      Effect.succeed(true),
    );
    const handlers = makeDesktopUpdateRpcHandlers(readBusy);
    const result = await Effect.runPromise(
      provideWsConnectionSession(
        handlers.action({
          action: "install",
          expectedVersion: "1.0.1-remote.1",
          confirmRestart: true,
          restartToken: "received-token",
        }),
        {
          role: "owner",
          attachmentPrincipal: { ownerKind: "session", ownerId: "owner" },
          desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
        },
      ),
    );
    expect(result.accepted).toBe(false);
    expect(result.status.busy).toBe(true);
    expect(
      vi.mocked(requestDesktopUpdate).mock.calls.some(([request]) => request.action === "install"),
    ).toBe(false);
  });

  it("keeps background ownership checks through session-list gaps and fails closed if unavailable", async () => {
    const threadId = ThreadId.makeUnsafe("background-owner-gap");
    expect(
      await Effect.runPromise(
        hasDesktopUpdateProviderWork([], [threadId], () => Effect.succeed(true)),
      ),
    ).toBe(true);
    expect(await Effect.runPromise(hasDesktopUpdateProviderWork([], [threadId], undefined))).toBe(
      true,
    );
    expect(
      await Effect.runPromise(
        hasDesktopUpdateProviderWork([], [threadId], () =>
          Effect.die(new Error("ownership unavailable")),
        ),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        hasDesktopUpdateProviderWork([{ threadId, status: "ready" }], [threadId], () =>
          Effect.succeed(false),
        ),
      ),
    ).toBe(false);
    expect(await Effect.runPromise(hasDesktopUpdateProviderWork([], [], undefined))).toBe(false);
  });

  it("allows a settled chat whose idle provider remains projected as running", () => {
    const settled = {
      deletedAt: null,
      session: { status: "running", activeTurnId: null },
      latestTurn: { state: "completed" },
      pendingInteractions: [{ status: "confirmed" }],
      claudeCacheReview: { status: "failed" },
    } satisfies Parameters<typeof hasDesktopUpdateThreadWork>[0];
    expect(hasDesktopUpdateThreadWork(settled)).toBe(false);
    expect(
      hasDesktopUpdateThreadWork({
        ...settled,
        session: { status: "running", activeTurnId: TurnId.makeUnsafe("active") },
      }),
    ).toBe(true);
    expect(
      hasDesktopUpdateThreadWork({
        ...settled,
        session: { status: "starting", activeTurnId: null },
      }),
    ).toBe(true);
    expect(hasDesktopUpdateThreadWork({ ...settled, latestTurn: { state: "running" } })).toBe(true);
    expect(
      hasDesktopUpdateThreadWork({ ...settled, pendingInteractions: [{ status: "pending" }] }),
    ).toBe(true);
  });
  it("rejects anonymous, ordinary client, and attachment-only sessions before parent IPC", async () => {
    const handlers = makeDesktopUpdateRpcHandlers(Effect.succeed(false));
    for (const session of [
      undefined,
      {
        role: "client" as const,
        attachmentPrincipal: {
          ownerKind: "session" as const,
          ownerId: "remote-device:attachment-lease",
        },
      },
      {
        role: "owner" as const,
        attachmentPrincipal: {
          ownerKind: "local-loopback" as const,
          ownerId: "local-loopback" as const,
        },
      },
    ]) {
      const result = await Effect.runPromise(
        provideWsConnectionSession(handlers.status, session).pipe(Effect.exit),
      );
      expect(result._tag).toBe("Failure");
    }
    expect(requestDesktopUpdate).not.toHaveBeenCalled();
  });

  it("admits authenticated owners and approved remote RPC sessions, then revokes remote authority", async () => {
    const handlers = makeDesktopUpdateRpcHandlers(Effect.succeed(false));
    const revoke = authorizeRemoteDesktopUpdateSession("paired");
    const remoteAuthority = desktopUpdateAuthorityForSession("paired", "client");
    const session = {
      role: "client" as const,
      attachmentPrincipal: { ownerKind: "session" as const, ownerId: "paired" },
      desktopUpdateAuthority: remoteAuthority,
    };
    expect(
      (await Effect.runPromise(provideWsConnectionSession(handlers.status, session))).supported,
    ).toBe(true);
    expect(
      (
        await Effect.runPromise(
          provideWsConnectionSession(handlers.status, {
            ...session,
            role: "owner",
            desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
          }),
        )
      ).supported,
    ).toBe(true);
    revoke();
    expect(
      (
        await Effect.runPromise(
          provideWsConnectionSession(handlers.status, session).pipe(Effect.exit),
        )
      )._tag,
    ).toBe("Failure");
  });

  it.each([Effect.succeed(true), Effect.fail(new Error("idleness unavailable"))])(
    "refuses install when work is active or idleness cannot be verified",
    async (readBusy) => {
      const handlers = makeDesktopUpdateRpcHandlers(readBusy);
      const result = await Effect.runPromise(
        provideWsConnectionSession(
          handlers.action({
            action: "install",
            expectedVersion: "1.0.1-remote.1",
            confirmRestart: true,
            restartToken: "received-token",
          }),
          {
            role: "owner",
            attachmentPrincipal: { ownerKind: "session", ownerId: "owner" },
            desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
          },
        ),
      );
      expect(result.accepted).toBe(false);
      expect(result.status.busy).toBe(true);
      expect(
        vi
          .mocked(requestDesktopUpdate)
          .mock.calls.some(([request]) => request.action === "install"),
      ).toBe(false);
    },
  );

  it("rechecks idleness when work starts during the parent status round trip", async () => {
    let busy = false;
    vi.mocked(requestDesktopUpdate).mockImplementationOnce(async () => {
      busy = true;
      return {
        accepted: true,
        status: { supported: true, state: null, busy: false, message: null },
      };
    });
    const handlers = makeDesktopUpdateRpcHandlers(Effect.sync(() => busy));
    const result = await Effect.runPromise(
      provideWsConnectionSession(
        handlers.action({
          action: "install",
          expectedVersion: "1.0.1-remote.1",
          confirmRestart: true,
          restartToken: "received-token",
        }),
        {
          role: "owner",
          attachmentPrincipal: { ownerKind: "session", ownerId: "owner" },
          desktopUpdateAuthority: desktopUpdateAuthorityForSession("owner", "owner"),
        },
      ),
    );
    expect(result.accepted).toBe(false);
    expect(result.status.busy).toBe(true);
    expect(
      vi.mocked(requestDesktopUpdate).mock.calls.some(([request]) => request.action === "install"),
    ).toBe(false);
  });
});
