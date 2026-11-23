import { type StatsUsageAnalyticsScope, WsRpcError } from "@synara/contracts";
import { Effect } from "effect";

import { CurrentWsSessionRole } from "./wsConnectionSessions";

/** The authenticated connection supplies this role; request payloads cannot grant it. */
export const requireWsOwnerSession = Effect.gen(function* () {
  if ((yield* CurrentWsSessionRole) !== "owner") {
    return yield* Effect.fail(
      new WsRpcError({ message: "Owner authorization is required for this operation." }),
    );
  }
});

/** Provider session files can include activity outside the paired Synara workspace. */
export function requireUsageAnalyticsAccess(scope: StatsUsageAnalyticsScope | undefined) {
  return scope === "mac" ? requireWsOwnerSession : Effect.succeed(undefined);
}
