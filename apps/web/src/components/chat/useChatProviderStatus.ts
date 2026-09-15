import {
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderStartOptions,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeCustomBinaryPath,
  normalizeProviderStatusForLocalConfig,
  providerStatusInstanceKey,
} from "~/lib/providerAvailability";
import type { AppSettings } from "../../appSettings";
import { getCustomBinaryPathForProviderInstance } from "../../appSettings";
import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "../../confirmedCustomBinaryPathStore";
import { type Thread } from "../../types";
import { shouldConsumePendingCustomBinaryConfirmation } from "../ChatView.logic";
import { isProviderKind } from "../../providerOrdering";
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
function getThreadProviderCustomBinaryPathKey(
  threadId: Thread["id"],
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | null | undefined,
) {
  return `${threadId}:${instanceId ?? provider}`;
}

function getConfirmedCustomBinarySessionKey(
  thread: Thread | null | undefined,
  provider: ProviderKind,
): string | null {
  const session = thread?.session;
  if (!thread || session?.provider !== provider) {
    return null;
  }
  if (session.status !== "ready" && session.status !== "running") {
    return null;
  }
  return getThreadProviderCustomBinaryPathKey(
    thread.id,
    provider,
    session.providerInstanceId ?? provider,
  );
}

function getProviderStartOptionsCustomBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string | null {
  switch (provider) {
    case "codex":
      return normalizeCustomBinaryPath(providerOptions?.codex?.binaryPath);
    case "claudeAgent":
      return normalizeCustomBinaryPath(providerOptions?.claudeAgent?.binaryPath);
    case "antigravity":
      return normalizeCustomBinaryPath(providerOptions?.antigravity?.binaryPath);
    case "grok":
      return normalizeCustomBinaryPath(providerOptions?.grok?.binaryPath);
    case "droid":
      return normalizeCustomBinaryPath(providerOptions?.droid?.binaryPath);
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
    case "cursor":
      return normalizeCustomBinaryPath(providerOptions?.cursor?.binaryPath);
    case "devin":
      return normalizeCustomBinaryPath(providerOptions?.devin?.binaryPath);
    case "pi":
      return normalizeCustomBinaryPath(providerOptions?.pi?.binaryPath);
  }
}
interface ChatProviderStatusInput {
  activeThread: Thread | undefined;
  settings: AppSettings;
  configuredProviderStatuses: readonly ServerProviderStatus[] | undefined;
}

export function useChatProviderStatus({
  activeThread,
  settings,
  configuredProviderStatuses,
}: ChatProviderStatusInput) {
  const [
    confirmedCustomBinaryPathsByProviderInstance,
    setConfirmedCustomBinaryPathsByProviderInstance,
  ] = useState<Partial<Record<ProviderInstanceId, string>>>(loadConfirmedCustomBinaryPaths);
  const confirmedCustomBinarySessionKeysRef = useRef<Set<string>>(new Set());
  const pendingCustomBinaryPathsByThreadProviderRef = useRef<Map<string, string>>(new Map());

  const rememberCustomBinaryPathForDispatch = useCallback(
    (input: {
      threadId: Thread["id"];
      provider: ProviderKind;
      providerInstanceId: ProviderInstanceId;
      providerOptions: ProviderStartOptions | undefined;
    }) => {
      const pendingKey = getThreadProviderCustomBinaryPathKey(
        input.threadId,
        input.provider,
        input.providerInstanceId,
      );
      const customBinaryPath = getProviderStartOptionsCustomBinaryPath(
        input.providerOptions,
        input.provider,
      );
      if (!customBinaryPath) {
        pendingCustomBinaryPathsByThreadProviderRef.current.delete(pendingKey);
        return;
      }
      pendingCustomBinaryPathsByThreadProviderRef.current.set(pendingKey, customBinaryPath);
    },
    [],
  );
  useEffect(() => {
    const provider = activeThread?.session?.provider;
    const providerInstanceId = activeThread?.session?.providerInstanceId ?? provider;
    if (!activeThread || !provider || !providerInstanceId) {
      return;
    }

    const sessionKey = getConfirmedCustomBinarySessionKey(activeThread, provider);
    if (!sessionKey) {
      confirmedCustomBinarySessionKeysRef.current.delete(
        getThreadProviderCustomBinaryPathKey(activeThread.id, provider, providerInstanceId),
      );
      return;
    }
    const customBinaryPath =
      pendingCustomBinaryPathsByThreadProviderRef.current.get(sessionKey) ?? null;
    if (
      !shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: confirmedCustomBinarySessionKeysRef.current.has(sessionKey),
        pendingCustomBinaryPath: customBinaryPath,
      })
    ) {
      return;
    }
    confirmedCustomBinarySessionKeysRef.current.add(sessionKey);

    pendingCustomBinaryPathsByThreadProviderRef.current.delete(sessionKey);
    if (!customBinaryPath) {
      return;
    }

    setConfirmedCustomBinaryPathsByProviderInstance((existing) =>
      existing[providerInstanceId] === customBinaryPath
        ? existing
        : {
            ...existing,
            [providerInstanceId]: customBinaryPath,
          },
    );
  }, [
    activeThread,
    activeThread?.id,
    activeThread?.session?.provider,
    activeThread?.session?.providerInstanceId,
    activeThread?.session?.status,
  ]);
  // Persist confirmations so a custom binary path that already started a session
  // stays trusted across restarts, instead of re-showing the availability warning.
  useEffect(() => {
    saveConfirmedCustomBinaryPaths(confirmedCustomBinaryPathsByProviderInstance);
  }, [confirmedCustomBinaryPathsByProviderInstance]);
  const providerStatuses = useMemo(
    () =>
      (configuredProviderStatuses ?? EMPTY_PROVIDER_STATUSES)
        .map((status) => {
          const provider = status.driver ?? status.provider;
          if (!isProviderKind(provider)) {
            return status;
          }
          const providerInstanceId = providerStatusInstanceKey(status);
          const customBinaryPath = getCustomBinaryPathForProviderInstance(
            settings,
            provider,
            providerInstanceId,
          );
          return normalizeProviderStatusForLocalConfig({
            provider,
            status,
            customBinaryPath,
            confirmedCustomBinaryPath:
              confirmedCustomBinaryPathsByProviderInstance[providerInstanceId],
            disabled: settings.disabledProviders.includes(provider),
          });
        })
        .flatMap((status) => (status ? [status] : [])),
    [confirmedCustomBinaryPathsByProviderInstance, configuredProviderStatuses, settings],
  );
  return { rememberCustomBinaryPathForDispatch, providerStatuses };
}
