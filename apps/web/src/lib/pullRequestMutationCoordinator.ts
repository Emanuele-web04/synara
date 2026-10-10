import type { PullRequestDetailInput, PullRequestSetPinnedInput } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type {
  PinCacheRollback,
  PullRequestActionListPatch,
  PullRequestListQueryScope,
} from "./pullRequestCache";
import {
  pullRequestIdentityKey,
  pullRequestRemoteIdentityKey,
  queryKeysEqual,
} from "./pullRequestCache";

export const PULL_REQUEST_ACTION_REFRESH_SCOPE_ID = "pull-requests:actions-and-refresh";

export type PinMutationContext = {
  identityKey: string;
  epoch: number;
  optimisticIsPinned: boolean;
  rollbackByQuery: PinCacheRollback[];
  affectedScopes: PullRequestListQueryScope[];
};

type PinMutationChain = {
  latestEpoch: number;
  activeEpochs: Set<number>;
  baselineByQuery: PinCacheRollback[];
  acknowledged: { epoch: number; isPinned: boolean } | null;
};

type PinMutationCoordinator = {
  nextEpoch: number;
  chainsByIdentity: Map<string, PinMutationChain>;
  nextRefreshId: number;
  activeRefreshProtectedIdentities: Map<number, Set<string>>;
  nextActionProtectionId: number;
  activeActionProtectionsByIdentity: Map<string, Map<number, PullRequestActionProtectionContext>>;
  activeRefreshProtectedActionFields: Map<
    number,
    Map<string, Set<keyof PullRequestActionListPatch>>
  >;
  pinWriteTailsByIdentity: Map<string, Promise<void>>;
};

export type PullRequestRefreshMutationContext = {
  refreshId: number;
  protectedPinIdentities: Set<string>;
  protectedActionFieldsByIdentity: Map<string, Set<keyof PullRequestActionListPatch>>;
};

export type PullRequestActionProtectionContext = {
  identityKey: string;
  protectionId: number;
  optimisticPatch: Readonly<PullRequestActionListPatch>;
  outcome: "pending" | "succeeded" | "failed";
  protectedFields: ReadonlySet<keyof PullRequestActionListPatch>;
};

export type PullRequestActionReadFence = ReadonlyMap<
  string,
  ReadonlyArray<PullRequestActionProtectionContext>
>;

const pinMutationCoordinators = new WeakMap<QueryClient, PinMutationCoordinator>();
const EMPTY_PULL_REQUEST_ACTION_READ_FENCE: PullRequestActionReadFence = new Map();

function getPinMutationCoordinator(queryClient: QueryClient): PinMutationCoordinator {
  const existing = pinMutationCoordinators.get(queryClient);
  if (existing) return existing;
  const created: PinMutationCoordinator = {
    nextEpoch: 0,
    chainsByIdentity: new Map(),
    nextRefreshId: 0,
    activeRefreshProtectedIdentities: new Map(),
    nextActionProtectionId: 0,
    activeActionProtectionsByIdentity: new Map(),
    activeRefreshProtectedActionFields: new Map(),
    pinWriteTailsByIdentity: new Map(),
  };
  pinMutationCoordinators.set(queryClient, created);
  return created;
}

/** Serialize local pin setters only for the same PR identity. Different PRs remain concurrent,
 * while a rapid pin/unpin pair reaches SQLite in the exact order the user produced it. */
export async function runPinMutationInIdentityOrder<T>(
  queryClient: QueryClient,
  input: PullRequestSetPinnedInput,
  write: () => Promise<T>,
): Promise<T> {
  const coordinator = getPinMutationCoordinator(queryClient);
  const identityKey = pullRequestIdentityKey(input);
  const previous = coordinator.pinWriteTailsByIdentity.get(identityKey) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(write);
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  coordinator.pinWriteTailsByIdentity.set(identityKey, tail);
  try {
    return await operation;
  } finally {
    if (coordinator.pinWriteTailsByIdentity.get(identityKey) === tail) {
      coordinator.pinWriteTailsByIdentity.delete(identityKey);
    }
  }
}

export function beginPinMutation(
  queryClient: QueryClient,
  input: PullRequestSetPinnedInput,
): Pick<PinMutationContext, "identityKey" | "epoch" | "optimisticIsPinned"> {
  const coordinator = getPinMutationCoordinator(queryClient);
  const identityKey = pullRequestIdentityKey(input);
  const epoch = ++coordinator.nextEpoch;
  const chain = coordinator.chainsByIdentity.get(identityKey) ?? {
    latestEpoch: epoch,
    activeEpochs: new Set<number>(),
    baselineByQuery: [],
    acknowledged: null,
  };
  chain.latestEpoch = epoch;
  chain.activeEpochs.add(epoch);
  coordinator.chainsByIdentity.set(identityKey, chain);
  for (const protectedIdentities of coordinator.activeRefreshProtectedIdentities.values()) {
    protectedIdentities.add(identityKey);
  }
  return { identityKey, epoch, optimisticIsPinned: input.isPinned };
}

export function recordPinMutationBaseline(queryClient: QueryClient, context: PinMutationContext) {
  const chain = getPinMutationCoordinator(queryClient).chainsByIdentity.get(context.identityKey);
  if (!chain?.activeEpochs.has(context.epoch)) return;
  for (const rollback of context.rollbackByQuery) {
    if (
      !chain.baselineByQuery.some((baseline) =>
        queryKeysEqual(baseline.queryKey, rollback.queryKey),
      )
    ) {
      chain.baselineByQuery.push(rollback);
    }
  }
}

export function recordPinMutationAcknowledgement(
  queryClient: QueryClient,
  context: PinMutationContext,
  isPinned: boolean,
) {
  const chain = getPinMutationCoordinator(queryClient).chainsByIdentity.get(context.identityKey);
  if (!chain?.activeEpochs.has(context.epoch)) return;
  if (!chain.acknowledged || context.epoch > chain.acknowledged.epoch) {
    chain.acknowledged = { epoch: context.epoch, isPinned };
  }
}

export function finishPinMutation(
  queryClient: QueryClient,
  context: PinMutationContext | undefined,
) {
  if (!context) return;
  const coordinator = getPinMutationCoordinator(queryClient);
  const chain = coordinator.chainsByIdentity.get(context.identityKey);
  if (!chain) return;
  chain.activeEpochs.delete(context.epoch);
  if (chain.activeEpochs.size === 0) {
    coordinator.chainsByIdentity.delete(context.identityKey);
  } else if (chain.latestEpoch === context.epoch) {
    let latestEpoch = 0;
    for (const activeEpoch of chain.activeEpochs) latestEpoch = Math.max(latestEpoch, activeEpoch);
    chain.latestEpoch = latestEpoch;
  }
}

export function isLatestPinMutation(
  queryClient: QueryClient,
  context: PinMutationContext,
): boolean {
  const chain = getPinMutationCoordinator(queryClient).chainsByIdentity.get(context.identityKey);
  return chain?.latestEpoch === context.epoch;
}

export function isFinalActivePinMutation(
  queryClient: QueryClient,
  context: PinMutationContext,
): boolean {
  const chain = getPinMutationCoordinator(queryClient).chainsByIdentity.get(context.identityKey);
  return chain?.activeEpochs.size === 1 && chain.activeEpochs.has(context.epoch);
}

export function pinMutationRollbackState(
  queryClient: QueryClient,
  context: PinMutationContext,
): { latest: boolean; acknowledgedIsPinned: boolean | null; baselineByQuery: PinCacheRollback[] } {
  const chain = getPinMutationCoordinator(queryClient).chainsByIdentity.get(context.identityKey);
  return {
    latest: chain?.latestEpoch === context.epoch,
    acknowledgedIsPinned: chain?.acknowledged?.isPinned ?? null,
    baselineByQuery: chain?.baselineByQuery ?? [],
  };
}

export function beginPullRequestRefresh(
  queryClient: QueryClient,
): PullRequestRefreshMutationContext {
  const coordinator = getPinMutationCoordinator(queryClient);
  const refreshId = ++coordinator.nextRefreshId;
  const protectedPinIdentities = new Set(coordinator.chainsByIdentity.keys());
  const protectedActionFieldsByIdentity = new Map<string, Set<keyof PullRequestActionListPatch>>();
  for (const [identityKey, protections] of coordinator.activeActionProtectionsByIdentity) {
    const fields = new Set<keyof PullRequestActionListPatch>();
    for (const protection of protections.values()) {
      if (protection.optimisticPatch.state !== undefined) fields.add("state");
      if (protection.optimisticPatch.isDraft !== undefined) fields.add("isDraft");
    }
    protectedActionFieldsByIdentity.set(identityKey, fields);
  }
  coordinator.activeRefreshProtectedIdentities.set(refreshId, protectedPinIdentities);
  coordinator.activeRefreshProtectedActionFields.set(refreshId, protectedActionFieldsByIdentity);
  return { refreshId, protectedPinIdentities, protectedActionFieldsByIdentity };
}

export function beginPullRequestActionProtection(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
  patch: PullRequestActionListPatch,
): PullRequestActionProtectionContext {
  const coordinator = getPinMutationCoordinator(queryClient);
  const identityKey = pullRequestRemoteIdentityKey(input);
  const protectionId = ++coordinator.nextActionProtectionId;
  const protectedFields = new Set<keyof PullRequestActionListPatch>();
  if (patch.state !== undefined) protectedFields.add("state");
  if (patch.isDraft !== undefined) protectedFields.add("isDraft");
  const context: PullRequestActionProtectionContext = {
    identityKey,
    protectionId,
    optimisticPatch: patch,
    outcome: "pending",
    protectedFields,
  };
  if (protectedFields.size === 0) return context;

  const protections = coordinator.activeActionProtectionsByIdentity.get(identityKey) ?? new Map();
  protections.set(protectionId, context);
  coordinator.activeActionProtectionsByIdentity.set(identityKey, protections);
  for (const refreshFields of coordinator.activeRefreshProtectedActionFields.values()) {
    const fields = refreshFields.get(identityKey) ?? new Set();
    for (const field of protectedFields) fields.add(field);
    refreshFields.set(identityKey, fields);
  }
  return context;
}

export function finishPullRequestActionProtection(
  queryClient: QueryClient,
  context: PullRequestActionProtectionContext,
  outcome: "succeeded" | "failed",
) {
  if (context.outcome === "pending") context.outcome = outcome;
  if (context.protectedFields.size === 0) return;
  const coordinator = getPinMutationCoordinator(queryClient);
  const protections = coordinator.activeActionProtectionsByIdentity.get(context.identityKey);
  if (!protections?.delete(context.protectionId)) return;
  if (protections.size === 0) {
    coordinator.activeActionProtectionsByIdentity.delete(context.identityKey);
  }
}

/** Capture live action records by reference before a Git request. Their eventual outcome lets a
 * late response preserve successful intent but discard an optimistic action that failed. */
export function capturePullRequestActionReadFence(
  queryClient: QueryClient,
): PullRequestActionReadFence {
  const coordinator = pinMutationCoordinators.get(queryClient);
  if (!coordinator || coordinator.activeActionProtectionsByIdentity.size === 0) {
    return EMPTY_PULL_REQUEST_ACTION_READ_FENCE;
  }
  const fence = new Map<string, ReadonlyArray<PullRequestActionProtectionContext>>();
  for (const [identityKey, protections] of coordinator.activeActionProtectionsByIdentity) {
    fence.set(identityKey, [...protections.values()]);
  }
  return fence;
}

export function hasPullRequestActionReadProtection(
  queryClient: QueryClient,
  readFence?: PullRequestActionReadFence,
): boolean {
  return (
    (readFence?.size ?? 0) > 0 ||
    (pinMutationCoordinators.get(queryClient)?.activeActionProtectionsByIdentity.size ?? 0) > 0
  );
}

/** Latest non-failed user intent for each action-owned field. The optional request-start fence
 * prevents a stale response from winning when it settles just after the mutation itself. */
export function activePullRequestActionPatch(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "repository" | "number">,
  readFence?: PullRequestActionReadFence,
): PullRequestActionListPatch {
  const identityKey = pullRequestRemoteIdentityKey(input);
  const protections = new Map<number, PullRequestActionProtectionContext>();
  for (const protection of readFence?.get(identityKey) ?? []) {
    protections.set(protection.protectionId, protection);
  }
  const coordinator = pinMutationCoordinators.get(queryClient);
  for (const protection of coordinator?.activeActionProtectionsByIdentity
    .get(identityKey)
    ?.values() ?? []) {
    protections.set(protection.protectionId, protection);
  }

  const activePatch: PullRequestActionListPatch = {};
  for (const protection of [...protections.values()].sort(
    (left, right) => left.protectionId - right.protectionId,
  )) {
    if (protection.outcome === "failed") continue;
    if (protection.optimisticPatch.state !== undefined) {
      activePatch.state = protection.optimisticPatch.state;
    }
    if (protection.optimisticPatch.isDraft !== undefined) {
      activePatch.isDraft = protection.optimisticPatch.isDraft;
    }
  }
  return activePatch;
}

export function protectedActionFieldsForRefresh(
  queryClient: QueryClient,
  context: PullRequestRefreshMutationContext,
): Map<string, Set<keyof PullRequestActionListPatch>> {
  const protectedFields = new Map<string, Set<keyof PullRequestActionListPatch>>();
  for (const [identityKey, fields] of context.protectedActionFieldsByIdentity) {
    protectedFields.set(identityKey, new Set(fields));
  }
  const coordinator = getPinMutationCoordinator(queryClient);
  for (const [identityKey, protections] of coordinator.activeActionProtectionsByIdentity) {
    const fields = protectedFields.get(identityKey) ?? new Set();
    for (const protection of protections.values()) {
      if (protection.optimisticPatch.state !== undefined) fields.add("state");
      if (protection.optimisticPatch.isDraft !== undefined) fields.add("isDraft");
    }
    protectedFields.set(identityKey, fields);
  }
  return protectedFields;
}

export function protectedPinIdentitiesForRefresh(
  queryClient: QueryClient,
  context: PullRequestRefreshMutationContext,
): Set<string> {
  const protectedIdentities = new Set(context.protectedPinIdentities);
  const coordinator = getPinMutationCoordinator(queryClient);
  for (const identityKey of coordinator.chainsByIdentity.keys()) {
    protectedIdentities.add(identityKey);
  }
  return protectedIdentities;
}

export function finishPullRequestRefresh(
  queryClient: QueryClient,
  context: PullRequestRefreshMutationContext | undefined,
) {
  if (!context) return;
  const coordinator = getPinMutationCoordinator(queryClient);
  coordinator.activeRefreshProtectedIdentities.delete(context.refreshId);
  coordinator.activeRefreshProtectedActionFields.delete(context.refreshId);
}
