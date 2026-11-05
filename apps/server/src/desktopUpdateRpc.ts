// Purpose: Admits owner shells and approved remote devices to desktop updater RPCs.
// Layer: Server transport; resource leases and provider credentials cannot grant this authority.
import { randomUUID } from "node:crypto";

import {
  WsRpcError,
  type DesktopUpdateIpcRequest,
  type OrchestrationLatestTurn,
  type OrchestrationPendingInteraction,
  type OrchestrationSession,
  type OrchestrationThread,
  type PendingClaudeCacheReview,
  type ProviderSession,
  type ServerDesktopUpdateInput,
  type ServerDesktopUpdateStatus,
  type ThreadId,
} from "@synara/contracts";
import { Effect, ServiceMap } from "effect";

import { desktopUpdateBridgeAvailable, requestDesktopUpdate } from "./desktopUpdateBridge";
import type { ProviderServiceShape } from "./provider/Services/ProviderService";

type DesktopUpdateThreadWork = Pick<
  OrchestrationThread,
  "deletedAt" | "hasPendingApprovals" | "hasPendingUserInput"
> & {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
  readonly pendingInteractions?:
    | readonly Pick<OrchestrationPendingInteraction, "status">[]
    | undefined;
  readonly claudeCacheReview?: Pick<PendingClaudeCacheReview, "status"> | null | undefined;
};

// ProviderService projects idle ready providers as running too; only turn/start evidence blocks.
// Live provider sessions are checked separately; this preserves projected intent and pending work.
export function hasDesktopUpdateThreadWork(thread: DesktopUpdateThreadWork): boolean {
  return (
    !thread.deletedAt &&
    (thread.session?.status === "starting" ||
      thread.session?.activeTurnId != null ||
      thread.latestTurn?.state === "running" ||
      thread.hasPendingApprovals === true ||
      thread.hasPendingUserInput === true ||
      thread.pendingInteractions?.some((interaction) => interaction.status !== "confirmed") ===
        true ||
      (thread.claudeCacheReview != null && thread.claudeCacheReview.status !== "failed"))
  );
}

// Provider background tasks may outlive the foreground turn and an adapter's session-list entry.
export function hasDesktopUpdateProviderWork(
  sessions: ReadonlyArray<Pick<ProviderSession, "threadId" | "status" | "activeTurnId">>,
  knownThreadIds: ReadonlyArray<ThreadId>,
  hasLiveRuntimeTasks: ProviderServiceShape["hasLiveRuntimeTasks"],
  listRetainedSessions?: ProviderServiceShape["listRetainedSessions"],
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // Failed stops are not routable live sessions, but still own unproven process cleanup.
    if (listRetainedSessions && (yield* listRetainedSessions()).length > 0) return true;
    if (
      sessions.some(
        (session) =>
          session.status === "running" ||
          session.status === "connecting" ||
          session.activeTurnId != null,
      )
    )
      return true;
    const threadIds = [
      ...new Set([...knownThreadIds, ...sessions.map((session) => session.threadId)]),
    ];
    if (threadIds.length === 0) return false;
    if (!hasLiveRuntimeTasks) return true;
    const tasks = yield* Effect.forEach(
      threadIds,
      (threadId) => hasLiveRuntimeTasks({ threadId }),
      { concurrency: 4 },
    );
    return tasks.some(Boolean);
  }).pipe(Effect.catchCause(() => Effect.succeed(true)));
}

const approvedRemoteSessions = new Map<string, string>();
export const CurrentDesktopUpdateAuthority = ServiceMap.Reference<string | undefined>(
  "synara/ws/DesktopUpdateAuthority",
  { defaultValue: () => undefined },
);

// Only the verified Remote gateway's RPC bridge calls this; attachment/resource binding does not.
export function authorizeRemoteDesktopUpdateSession(sessionId: string): () => void {
  const authority = `remote:${randomUUID()}`;
  approvedRemoteSessions.set(sessionId, authority);
  return () => {
    if (approvedRemoteSessions.get(sessionId) === authority)
      approvedRemoteSessions.delete(sessionId);
  };
}

export function desktopUpdateAuthorityForSession(
  sessionId: string,
  role: "owner" | "client",
): string | undefined {
  return role === "owner" ? `owner:${sessionId}` : approvedRemoteSessions.get(sessionId);
}

// Busy reads fail closed, including a provider/session read that cannot establish idleness.
export function makeDesktopUpdateRpcHandlers<E, R>(readBusy: Effect.Effect<boolean, E, R>) {
  const busy = readBusy.pipe(Effect.catch(() => Effect.succeed(true)));
  const authority = Effect.gen(function* () {
    const value = yield* CurrentDesktopUpdateAuthority;
    if (
      !value ||
      (!value.startsWith("owner:") && !Array.from(approvedRemoteSessions.values()).includes(value))
    ) {
      return yield* Effect.fail(
        new WsRpcError({
          message: "Desktop updates require an authenticated owner or approved remote device.",
        }),
      );
    }
    return value;
  });
  const request = (input: Omit<DesktopUpdateIpcRequest, "type" | "id">) =>
    Effect.tryPromise({
      try: () => requestDesktopUpdate(input),
      catch: () =>
        new WsRpcError({
          message: "Desktop updater is unavailable. Reconnect and refresh its status.",
        }),
    });
  const status = Effect.gen(function* () {
    const caller = yield* authority;
    const isBusy = yield* busy;
    if (!desktopUpdateBridgeAvailable())
      return {
        supported: false,
        state: null,
        busy: isBusy,
        message: "Remote updates require the packaged Synara Remote app on macOS.",
      } satisfies ServerDesktopUpdateStatus;
    const result = yield* request({ action: "status", authority: caller });
    return {
      ...result.status,
      busy: isBusy || result.status.busy,
      message:
        result.status.message ??
        (isBusy ? "Finish running chats and tasks before restarting Synara." : null),
    };
  });
  const action = (input: ServerDesktopUpdateInput) =>
    Effect.gen(function* () {
      const caller = yield* authority;
      if (input.action === "install" && (input.confirmRestart !== true || !input.expectedVersion)) {
        return yield* Effect.fail(
          new WsRpcError({
            message:
              "Confirm the downloaded update version and the connection interruption before restarting.",
          }),
        );
      }
      const current = yield* status;
      if (!current.supported || (input.action === "install" && current.busy))
        return { accepted: false, status: current };
      // The parent status round trip may overlap a turn start; re-read immediately before commit.
      if (input.action === "install" && (yield* busy)) {
        return {
          accepted: false,
          status: {
            ...current,
            busy: true,
            message: "Finish running chats and tasks before restarting Synara.",
          },
        };
      }
      const result = yield* request({
        action: input.action,
        authority: caller,
        ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
        ...(input.restartToken ? { restartToken: input.restartToken } : {}),
      });
      return { ...result, status: { ...result.status, busy: current.busy || result.status.busy } };
    });
  return { status, action };
}
