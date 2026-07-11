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
  disabled?: boolean | undefined;
}): ServerProviderStatus | null {
  const status = input.status ?? null;
  if (!status) {
    return null;
  }
  if (input.disabled) {
    return {
      ...status,
      provider: input.provider,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: status.checkedAt,
      message: "Provider is disabled in Synara settings.",
    };
  }

  if (status.enabled === false) {
    return status;
  }

  const customBinaryPath = normalizeCustomBinaryPath(input.customBinaryPath);
  if (!customBinaryPath) {
    return status;
  }

  if (normalizeCustomBinaryPath(status.autoRuntimeModeBinaryPath) === customBinaryPath) {
    return status;
  }

  const {
    supportsAutoRuntimeMode: _staleAutoSupport,
    autoRuntimeModeBinaryPath: _staleAutoBinaryPath,
    availability: _staleAvailability,
    unavailableReason: _staleUnavailableReason,
    ...statusWithoutStaleAutoCapability
  } = status;

  if (status.available || status.authStatus !== "unknown") {
    return statusWithoutStaleAutoCapability;
  }

  if (normalizeCustomBinaryPath(input.confirmedCustomBinaryPath) === customBinaryPath) {
    // Only the exact path used by a successful session can suppress the warning.
    const { message: _message, ...confirmedStatus } = statusWithoutStaleAutoCapability;
    return {
      ...confirmedStatus,
      available: true,
      ...(_staleAvailability !== undefined ? { availability: "available" as const } : {}),
      status: "ready",
    };
  }

  return {
    ...statusWithoutStaleAutoCapability,
    available: true,
    ...(_staleAvailability !== undefined ? { availability: "available" as const } : {}),
    status: "warning",
    message: `${PROVIDER_DISPLAY_NAMES[input.provider]} uses a custom local binary path in this app. ${CUSTOM_BINARY_CONFIRMATION_SUFFIX}`,
  };
}

export function providerStatusInstanceKey(
  status: Pick<ServerProviderStatus, "provider" | "instanceId">,
): ProviderInstanceId {
  return status.instanceId ?? status.provider;
}

// Advisory warnings the health layer marks available (Pi bundled SDK, Cursor
// model-discovery warnings, unconfirmed custom binaries) stay sendable; only
// unavailable or unauthenticated statuses block sends.
export function isProviderUsable(status: ServerProviderStatus | null | undefined): boolean {
  if (!status) {
    // Missing status means the health check has not confirmed an installed provider yet.
    return false;
  }
  return status.available && status.authStatus !== "unauthenticated";
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
  if (instanceId) {
    return (
      statuses.find(
        (status) =>
          (status.driver ?? status.provider) === provider &&
          (status.instanceId ?? status.provider) === instanceId,
      ) ?? null
    );
  }
  return statuses.find((status) => (status.driver ?? status.provider) === provider) ?? null;
}

export function resolveAvailableProviderPreference(input: {
  readonly preferredProvider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerOrder?: readonly ProviderKind[];
  readonly hiddenProviders?: readonly ProviderKind[];
}): ProviderKind {
  if (input.statuses.length === 0) {
    return input.preferredProvider;
  }

  const preferredStatus = findProviderStatus(input.statuses, input.preferredProvider);
  if (isProviderUsable(preferredStatus)) {
    return input.preferredProvider;
  }

  const hiddenProviders = new Set(input.hiddenProviders ?? []);
  const providerOrder = input.providerOrder ?? [];
  const providerForStatus = (status: ServerProviderStatus): ProviderKind | null => {
    const driver = status.driver ?? status.provider;
    return isProviderKind(driver) ? driver : null;
  };
  const orderedStatuses = input.statuses.toSorted((left, right) => {
    const leftProvider = providerForStatus(left);
    const rightProvider = providerForStatus(right);
    const leftIndex = leftProvider ? providerOrder.indexOf(leftProvider) : -1;
    const rightIndex = rightProvider ? providerOrder.indexOf(rightProvider) : -1;
    const normalizedLeft = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const normalizedRight = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return normalizedLeft - normalizedRight;
  });
  const visibleInstalled = orderedStatuses.filter(
    (status) => {
      const provider = providerForStatus(status);
      return status.available && provider !== null && !hiddenProviders.has(provider);
    },
  );
  const installed =
    visibleInstalled.length > 0
      ? visibleInstalled
      : orderedStatuses.filter((status) => status.available && providerForStatus(status) !== null);

  const preferredInstalled =
    installed.find((status) => status.authStatus !== "unauthenticated") ?? installed[0];
  return (
    (preferredInstalled ? providerForStatus(preferredInstalled) : null) ?? input.preferredProvider
  );
}

export interface VoiceTranscriptionTarget {
  readonly instanceId: ProviderInstanceId;
  readonly status: ServerProviderStatus;
}

// Voice always uses a Codex ChatGPT session. Prefer the actively selected Codex
// account when it advertises voice, otherwise choose a usable configured account
// by identity (default first, then stable instance id). Status-only identities are
// deliberately ignored because they can outlive a removed or disabled account.
export function resolveVoiceTranscriptionTarget(input: {
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderKind;
    readonly enabled: boolean;
    readonly isDefault: boolean;
  }>;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderInstanceId: ProviderInstanceId;
}): VoiceTranscriptionTarget | null {
  const statusByInstanceId = new Map<ProviderInstanceId, ServerProviderStatus>();
  for (const status of input.statuses) {
    if ((status.driver ?? status.provider) !== "codex") {
      continue;
    }
    statusByInstanceId.set(providerStatusInstanceKey(status), status);
  }

  const orderedInstanceIds = input.providerInstances
    .filter((instance) => instance.provider === "codex" && instance.enabled)
    .toSorted((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return String(left.instanceId).localeCompare(String(right.instanceId));
    })
    .map((instance) => instance.instanceId);

  if (input.selectedProvider === "codex") {
    const selectedIndex = orderedInstanceIds.indexOf(input.selectedProviderInstanceId);
    if (selectedIndex >= 0) {
      orderedInstanceIds.splice(selectedIndex, 1);
      orderedInstanceIds.unshift(input.selectedProviderInstanceId);
    }
  }

  const isUsableVoiceStatus = (instanceId: ProviderInstanceId): boolean => {
    const status = statusByInstanceId.get(instanceId);
    return isProviderUsable(status);
  };
  const capableInstanceId = orderedInstanceIds.find((instanceId) => {
    const status = statusByInstanceId.get(instanceId);
    return isUsableVoiceStatus(instanceId) && status?.voiceTranscriptionAvailable === true;
  });
  const fallbackInstanceId =
    capableInstanceId ?? orderedInstanceIds.find((instanceId) => isUsableVoiceStatus(instanceId));
  if (!fallbackInstanceId) {
    return null;
  }
  const status = statusByInstanceId.get(fallbackInstanceId);
  return status ? { instanceId: fallbackInstanceId, status } : null;
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
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    statuses: refreshedStatuses,
  });
}
