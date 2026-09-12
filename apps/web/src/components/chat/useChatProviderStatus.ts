import {
  type ProviderKind,
  type ProviderStartOptions,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeCustomBinaryPath,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import type { AppSettings } from "../../appSettings";
import { getCustomBinaryPathForProvider } from "../../appSettings";
import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "../../confirmedCustomBinaryPathStore";
import { type Thread } from "../../types";
import { shouldConsumePendingCustomBinaryConfirmation } from "../ChatView.logic";
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
function getThreadProviderCustomBinaryPathKey(threadId: Thread["id"], provider: ProviderKind) {
  return `${threadId}:${provider}`;
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
  return getThreadProviderCustomBinaryPathKey(thread.id, provider);
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
  const [confirmedCustomBinaryPathsByProvider, setConfirmedCustomBinaryPathsByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >(loadConfirmedCustomBinaryPaths);
  const confirmedCustomBinarySessionKeysRef = useRef<Set<string>>(new Set());
  const pendingCustomBinaryPathsByThreadProviderRef = useRef<Map<string, string>>(new Map());

  const rememberCustomBinaryPathForDispatch = useCallback(
    (input: {
      threadId: Thread["id"];
      provider: ProviderKind;
      providerOptions: ProviderStartOptions | undefined;
    }) => {
      const pendingKey = getThreadProviderCustomBinaryPathKey(input.threadId, input.provider);
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
    if (!activeThread || !provider) {
      return;
    }

    const sessionKey = getConfirmedCustomBinarySessionKey(activeThread, provider);
    if (!sessionKey) {
      confirmedCustomBinarySessionKeysRef.current.delete(
        getThreadProviderCustomBinaryPathKey(activeThread.id, provider),
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

    setConfirmedCustomBinaryPathsByProvider((existing) =>
      existing[provider] === customBinaryPath
        ? existing
        : {
            ...existing,
            [provider]: customBinaryPath,
          },
    );
  }, [
    activeThread,
    activeThread?.id,
    activeThread?.session?.provider,
    activeThread?.session?.status,
  ]);
  // Persist confirmations so a custom binary path that already started a session
  // stays trusted across restarts, instead of re-showing the availability warning.
  useEffect(() => {
    saveConfirmedCustomBinaryPaths(confirmedCustomBinaryPathsByProvider);
  }, [confirmedCustomBinaryPathsByProvider]);
  const providerStatuses = useMemo(
    () =>
      (configuredProviderStatuses ?? EMPTY_PROVIDER_STATUSES)
        .map((status) => {
          const customBinaryPath = getCustomBinaryPathForProvider(settings, status.provider);
          return normalizeProviderStatusForLocalConfig({
            provider: status.provider,
            status,
            customBinaryPath,
            confirmedCustomBinaryPath: confirmedCustomBinaryPathsByProvider[status.provider],
            disabled: settings.disabledProviders.includes(status.provider),
          });
        })
        .flatMap((status) => (status ? [status] : [])),
    [confirmedCustomBinaryPathsByProvider, configuredProviderStatuses, settings],
  );
  return { rememberCustomBinaryPathForDispatch, providerStatuses };
}
