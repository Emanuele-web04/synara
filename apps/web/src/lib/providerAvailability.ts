import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { isProviderKind } from "../providerOrdering";

const CUSTOM_BINARY_CONFIRMATION_SUFFIX =
  "Availability will be confirmed when you start a session.";

export interface ProviderSendAvailability {
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus | null;
  readonly usable: boolean;
  readonly unavailableReason: string;
}

export type ProviderStatusRefresh = () => Promise<
  readonly ServerProviderStatus[] | null | undefined
>;

export function normalizeCustomBinaryPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProviderStatusForLocalConfig(input: {
  provider: ProviderKind;
  status: ServerProviderStatus | null | undefined;
  customBinaryPath?: string | null | undefined;
  confirmedCustomBinaryPath?: string | null | undefined;
}): ServerProviderStatus | null {
  const status = input.status ?? null;
  if (!status) {
    return null;
  }

  const customBinaryPath = normalizeCustomBinaryPath(input.customBinaryPath);
  if (!customBinaryPath) {
    return status;
  }

  if (status.enabled === false) {
    return status;
  }

  if (status.available || status.authStatus !== "unknown") {
    return status;
  }

  if (normalizeCustomBinaryPath(input.confirmedCustomBinaryPath) === customBinaryPath) {
    // Only the exact path used by a successful session can suppress the warning.
    const { message: _message, ...confirmedStatus } = status;
    return {
      ...confirmedStatus,
      available: true,
      status: "ready",
    };
  }

  return {
    ...status,
    available: true,
    status: "warning",
    message: `${PROVIDER_DISPLAY_NAMES[input.provider]} uses a custom local binary path in this app. ${CUSTOM_BINARY_CONFIRMATION_SUFFIX}`,
  };
}

export function providerStatusInstanceKey(
  status: Pick<ServerProviderStatus, "provider" | "instanceId">,
): ProviderInstanceId {
  return (status.instanceId ?? status.provider) as ProviderInstanceId;
}

// Advisory warnings the health layer marks available (Pi bundled SDK, Cursor
// model-discovery warnings, unconfirmed custom binaries) stay sendable; only
// unavailable or unauthenticated statuses block sends.
export function isProviderUsable(status: ServerProviderStatus | null | undefined): boolean {
  if (!status) {
    // Missing status means the health check has not confirmed an installed provider yet.
    return false;
  }
  return status.enabled !== false && status.available && status.authStatus !== "unauthenticated";
}

export function providerUnavailableReason(status: ServerProviderStatus | null | undefined): string {
  if (!status) {
    return "Provider status is still loading.";
  }
  const providerLabelFallback = isProviderKind(status.provider)
    ? PROVIDER_DISPLAY_NAMES[status.provider]
    : status.provider;
  const providerLabel = status.displayName?.trim() || providerLabelFallback || status.provider;
  if (status.authStatus === "unauthenticated") {
    return `${providerLabel} is not authenticated yet.`;
  }
  if (!status.available) {
    return status.message ?? `${providerLabel} is unavailable right now.`;
  }
  return status.message ?? `${providerLabel} has limited availability right now.`;
}

export function findProviderStatus(
  statuses: readonly ServerProviderStatus[],
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | null | undefined,
): ServerProviderStatus | null {
  const targetInstanceId = instanceId ?? provider;
  return (
    statuses.find(
      (status) =>
        (status.driver ?? status.provider) === provider &&
        (status.instanceId ?? status.provider) === targetInstanceId,
    ) ?? null
  );
}

// Shared send gate used by chat, Kanban, shortcuts, and handoff flows.
export function resolveProviderSendAvailability(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly statuses: readonly ServerProviderStatus[];
}): ProviderSendAvailability {
  const status = findProviderStatus(input.statuses, input.provider, input.instanceId);
  return {
    provider: input.provider,
    status,
    usable: isProviderUsable(status),
    unavailableReason: providerUnavailableReason(status),
  };
}

function shouldRefreshBeforeBlocking(status: ServerProviderStatus | null): boolean {
  return !status || !status.available || status.authStatus === "unauthenticated";
}

// Re-check a blocked provider once before surfacing stale install/auth state to the user.
export async function resolveProviderSendAvailabilityWithRefresh(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly statuses: readonly ServerProviderStatus[];
  readonly refreshStatuses: ProviderStatusRefresh;
}): Promise<ProviderSendAvailability> {
  const initial = resolveProviderSendAvailability(input);
  if (initial.usable || !shouldRefreshBeforeBlocking(initial.status)) {
    return initial;
  }

  let refreshedStatuses: readonly ServerProviderStatus[] | null | undefined;
  try {
    refreshedStatuses = await input.refreshStatuses();
  } catch {
    refreshedStatuses = null;
  }
  if (!refreshedStatuses) {
    return initial;
  }

  return resolveProviderSendAvailability({
    provider: input.provider,
    instanceId: input.instanceId,
    statuses: refreshedStatuses,
  });
}
