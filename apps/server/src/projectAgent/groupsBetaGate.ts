// FILE: groupsBetaGate.ts
// Purpose: Keeps Groups out of Stable. On a build where the "groups" Beta-only
//          feature is off, the project-agent service refuses every group API,
//          stops its background work, and treats group threads as ordinary
//          threads, so group state written by a Beta build stays inert.
// Layer: Runtime gate (wraps ProjectAgentService; read by wsRpc and the gateway)
// Exports: GROUPS_BETA_ONLY_MESSAGE, isServerGroupsEnabled, isGroupProjectCommand,
//          gateProjectAgentServiceForStable

import { GROUPS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Effect, Stream } from "effect";

import { isServerBetaFeatureEnabled } from "../betaFeatureGate";
import { ProjectAgentServiceError } from "./Errors";
import type { ProjectAgentServiceShape } from "./Services/ProjectAgentService";

export const GROUPS_BETA_ONLY_MESSAGE = "Hubs are available in Synara Beta.";

export const isServerGroupsEnabled = (): boolean => isServerBetaFeatureEnabled(GROUPS_BETA_FEATURE);

/** A client command that would create or re-kind a project as a group. */
export function isGroupProjectCommand(command: {
  readonly type: string;
  readonly kind?: unknown;
}): boolean {
  return (
    (command.type === "project.create" || command.type === "project.meta.update") &&
    command.kind === "group"
  );
}

const refuse = () =>
  Effect.fail(
    new ProjectAgentServiceError({ message: GROUPS_BETA_ONLY_MESSAGE, code: "forbidden" }),
  );

/**
 * The Stable face of the project-agent service. Group APIs fail with a Beta
 * message; lists the web reads everywhere come back empty instead of failing;
 * monitoring, wakes, and digests do nothing; and the per-turn hooks answer as
 * they do for a thread outside any group, so an existing group's threads keep
 * working as plain chats. Deleting a project still cleans up its group data.
 */
export function gateProjectAgentServiceForStable(
  service: ProjectAgentServiceShape,
): ProjectAgentServiceShape {
  return {
    notifyWorkItemChanged: () => Effect.void,
    getOverview: refuse,
    listSummaries: () => Effect.succeed({ summaries: [] }),
    configure: refuse,
    linkProject: refuse,
    unlinkProject: refuse,
    linkRepository: refuse,
    remember: refuse,
    forget: refuse,
    libraryList: refuse,
    libraryAdd: refuse,
    listGroupThreads: refuse,
    pauseGroup: refuse,
    resumeGroup: refuse,
    archiveGroup: refuse,
    unarchiveGroup: refuse,
    restartCoordinator: refuse,
    deleteGroup: refuse,
    assertGroupCoordinatorTurnAllowed: () => Effect.void,
    assertCallerMayCreateThreadInProject: () => Effect.void,
    startGoal: refuse,
    updateGoal: refuse,
    pauseGoal: refuse,
    resumeGoal: refuse,
    stopGoal: refuse,
    listTasks: refuse,
    createTask: refuse,
    updateTask: refuse,
    listActivity: refuse,
    listDocuments: refuse,
    readDocument: refuse,
    writeDocument: refuse,
    exportDocuments: refuse,
    refreshDigest: refuse,
    scheduleDigest: () => Effect.void,
    listEvidence: refuse,
    listThreadIndex: refuse,
    excludeThread: refuse,
    backfillSummaries: refuse,
    formatContextPacketForTurn: () => Effect.succeed(""),
    authorizeManagedGoalCreation: () => Effect.void,
    recordManagedWorkerThreads: () => Effect.void,
    reconcilePendingWakes: () => Effect.void,
    inspectWorkerHealth: () => Effect.void,
    reportResult: refuse,
    buildContextPacket: refuse,
    ingestSettledThreadEvent: () => Effect.void,
    processPendingWakes: () => Effect.void,
    recordWorkerTurnRequest: () => Effect.void,
    resolveWorkerAlert: refuse,
    resolvePrincipalForThread: refuse,
    assertCallerMayDriveManagedThread: () => Effect.void,
    onProjectDeleted: service.onProjectDeleted,
    streamEvents: () => Stream.empty,
  };
}
