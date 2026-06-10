// FILE: -ProviderUpdateNotifications.tsx
// Purpose: Surfaces provider-update prompts and drives the "Update all" toast flow from server config.
// Layer: Root route component
// Exports: ProviderUpdateNotifications mount point (renders nothing; manages toasts).

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "../components/ui/toast";
import { useFocusedChatContext } from "../focusedChatContext";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

const seenProviderUpdateNotificationKeys = new Set<string>();

type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;
type ActiveProviderUpdateToast =
  | { readonly kind: "prompt"; readonly key: string; readonly toastId: ProviderUpdateToastId }
  | { readonly kind: "update"; readonly key: string; readonly toastId: ProviderUpdateToastId };

function isProviderUpdateActive(provider: ServerProviderStatus): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

function providerUpdateNotificationKey(
  providers: ReadonlyArray<ServerProviderStatus>,
): string | null {
  const parts = providers
    .map((provider) =>
      [provider.provider, provider.versionAdvisory?.latestVersion ?? "unknown"].join(":"),
    )
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}

export function ProviderUpdateNotifications() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const { activeThread } = useFocusedChatContext();
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const isUpdatingAllRef = useRef(false);
  const progressToastDismissedRef = useRef(false);
  const outdatedProviders = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? []).filter(
        (provider) =>
          provider.versionAdvisory?.status === "behind_latest" &&
          provider.versionAdvisory.latestVersion !== null &&
          provider.versionAdvisory.canUpdate === true &&
          provider.versionAdvisory.updateCommand !== null,
      ),
    [serverConfigQuery.data?.providers],
  );
  const oneClickProviders = useMemo(
    () => outdatedProviders.filter((provider) => !isProviderUpdateActive(provider)),
    [outdatedProviders],
  );
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(outdatedProviders),
    [outdatedProviders],
  );

  const updateAll = useCallback(
    async (providers: ReadonlyArray<ServerProviderStatus>) => {
      const activeNotificationKey = providerUpdateNotificationKey(providers);
      if (isUpdatingAllRef.current || providers.length === 0 || !activeNotificationKey) {
        return;
      }

      isUpdatingAllRef.current = true;
      progressToastDismissedRef.current = false;
      setIsUpdatingAll(true);
      const trackedToast = activeToastRef.current;
      const toastId =
        trackedToast?.toastId ??
        toastManager.add({
          type: "loading",
          title: "Updating providers...",
          description:
            providers.length === 1
              ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
              : `Updating ${providers.length} providers.`,
          timeout: 0,
        });
      activeToastRef.current = { kind: "update", key: activeNotificationKey, toastId };
      const dismissProgressToast = () => {
        progressToastDismissedRef.current = true;
        if (activeToastRef.current?.toastId === toastId) {
          activeToastRef.current = null;
        }
        toastManager.close(toastId);
      };

      toastManager.update(toastId, {
        type: "loading",
        title: "Updating providers...",
        description:
          providers.length === 1
            ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
            : `Updating ${providers.length} providers.`,
        actionProps: undefined,
        data: { onClose: dismissProgressToast },
        timeout: 0,
      });

      const failures: Array<{ provider: ServerProviderStatus; reason: string }> = [];

      try {
        const api = ensureNativeApi();
        for (const provider of providers) {
          try {
            const result = await api.server.updateProvider({ provider: provider.provider });
            const refreshed = result.providers.find(
              (entry) => entry.provider === provider.provider,
            );
            const updateState = refreshed?.updateState;
            if (updateState?.status === "failed" || updateState?.status === "unchanged") {
              failures.push({
                provider,
                reason: updateState.message ?? "The update command did not complete successfully.",
              });
            } else if (refreshed?.versionAdvisory?.status === "behind_latest") {
              failures.push({
                provider,
                reason: "The provider still appears outdated after updating.",
              });
            }
          } catch (error) {
            failures.push({
              provider,
              reason: error instanceof Error ? error.message : "The update request failed.",
            });
          }
        }
      } catch (error) {
        for (const provider of providers) {
          failures.push({
            provider,
            reason:
              error instanceof Error
                ? error.message
                : "The provider update request could not start.",
          });
        }
      } finally {
        // Refresh is best-effort UI sync; it must not keep the progress toast alive.
        await queryClient
          .invalidateQueries({ queryKey: serverQueryKeys.config() })
          .catch(() => undefined);
        isUpdatingAllRef.current = false;
        setIsUpdatingAll(false);
      }

      if (progressToastDismissedRef.current || activeToastRef.current?.toastId !== toastId) {
        return;
      }

      if (failures.length > 0) {
        activeToastRef.current = null;
        toastManager.update(toastId, {
          type: "error",
          title:
            failures.length === providers.length
              ? "Provider updates failed"
              : "Some provider updates failed",
          description: failures
            .map(
              ({ provider, reason }) => `${PROVIDER_DISPLAY_NAMES[provider.provider]}: ${reason}`,
            )
            .join("\n"),
          data: { onClose: dismissProgressToast },
          timeout: 0,
        });
        return;
      }

      activeToastRef.current = null;
      toastManager.update(toastId, {
        type: "success",
        title:
          providers.length === 1
            ? `${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]} updated`
            : `${providers.length} providers updated`,
        description: "New sessions will use the refreshed provider tools.",
        data: { onClose: dismissProgressToast },
        timeout: 6000,
      });
    },
    [queryClient],
  );

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      outdatedProviders.length === 0 ||
      oneClickProviders.length === 0 ||
      !notificationKey ||
      !activeThread ||
      isUpdatingAll ||
      activeToastRef.current ||
      seenProviderUpdateNotificationKeys.has(notificationKey)
    ) {
      return;
    }

    // Key the prompt by the complete provider/version set so a partial refresh
    // cannot stack a second "Update all" prompt on top of the first one.
    seenProviderUpdateNotificationKeys.add(notificationKey);

    const firstProvider = outdatedProviders[0]!;
    const additionalCount = outdatedProviders.length - 1;
    const providerName = PROVIDER_DISPLAY_NAMES[firstProvider.provider];
    const title =
      outdatedProviders.length === 1
        ? `${providerName} update available`
        : `${outdatedProviders.length} provider updates available`;
    const description =
      outdatedProviders.length === 1
        ? `${providerName} has a newer version available.`
        : `${providerName} and ${additionalCount} more provider${additionalCount === 1 ? "" : "s"} have newer versions available.`;

    let toastId!: ProviderUpdateToastId;
    const closeTrackedPrompt = () => {
      if (activeToastRef.current?.toastId === toastId) {
        activeToastRef.current = null;
      }
      toastManager.close(toastId);
    };
    toastId = toastManager.add({
      type: "warning",
      title,
      description,
      timeout: 0,
      actionProps: {
        children: "Review updates",
        onClick: () => {
          if (activeToastRef.current?.toastId === toastId) {
            toastManager.close(toastId);
            activeToastRef.current = null;
          }
          void navigate({
            to: "/settings",
            search: { section: "providers", target: "provider-updates" },
          });
        },
      },
      data: {
        onClose: closeTrackedPrompt,
        secondaryActionProps: {
          children: "Update all",
          onClick: () => {
            void updateAll(oneClickProviders);
          },
        },
      },
    });
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [
    activeThread,
    isUpdatingAll,
    navigate,
    notificationKey,
    oneClickProviders,
    outdatedProviders,
    updateAll,
  ]);

  return null;
}
