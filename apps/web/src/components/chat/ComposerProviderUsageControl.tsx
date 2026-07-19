// FILE: ComposerProviderUsageControl.tsx
// Purpose: Active-provider quota trigger in the composer footer. Supported providers
// query one scoped, account-only server snapshot.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { isProviderUsageSupported } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";

import {
  ProviderUsageMenuPopup,
  type ProviderUsageMenuModel,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { MenuTrigger } from "~/components/ui/menu";
import { ChevronDownIcon } from "~/lib/icons";
import { createUnavailableProviderUsageSnapshot } from "~/lib/providerUsageSnapshot";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME } from "./composerPickerStyles";

export function resolveComposerProviderUsageSnapshot(input: {
  provider: ProviderKind;
  snapshots: readonly ServerProviderUsageSnapshot[] | undefined;
  querySettled: boolean;
  queryFailed: boolean;
}): ServerProviderUsageSnapshot | undefined {
  if (input.queryFailed) {
    return createUnavailableProviderUsageSnapshot(input.provider, "provider-usage-query");
  }

  const exactSnapshot = input.snapshots?.find((snapshot) => snapshot.provider === input.provider);
  if (exactSnapshot) {
    return exactSnapshot;
  }

  if (!input.querySettled) {
    return undefined;
  }
  return createUnavailableProviderUsageSnapshot(input.provider, "provider-usage-query");
}

export interface ComposerProviderUsageTriggerPresentation {
  primaryText: string;
  resetText: string | null;
  accessibleLabel: string;
}

export function composerProviderUsageContentSizeKey(model: ProviderUsageMenuModel): string {
  return [model.state, model.primaryRow?.leftText, model.primaryRow?.resetText].join(":");
}

export function deriveComposerProviderUsageTriggerPresentation(
  model: ProviderUsageMenuModel,
  showReset: boolean,
): ComposerProviderUsageTriggerPresentation {
  const primaryText = model.primaryRow
    ? model.primaryRow.leftText
    : model.state === "loading"
      ? "Checking…"
      : model.state === "needs-auth"
        ? "Sign in"
        : model.state === "unsupported"
          ? "Unsupported"
          : model.state === "error"
            ? "Unavailable"
            : model.state === "ready"
              ? "Usage"
              : "No data";
  const accessibleResetText = model.primaryRow?.resetText ?? null;
  const resetText = showReset ? accessibleResetText : null;
  const accessibleLabel = [model.menuTitle, primaryText, accessibleResetText]
    .filter(Boolean)
    .join(": ");

  return { primaryText, resetText, accessibleLabel };
}

export function ComposerProviderUsageControl({
  provider,
  showReset,
  onContentSizeChange,
}: {
  provider: ProviderKind;
  showReset: boolean;
  onContentSizeChange?: () => void;
}) {
  const queryEnabled = isProviderUsageSupported(provider);
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: queryEnabled,
      includeLocalUsage: false,
      provider,
    }),
  );
  const providerSnapshot = useMemo(
    () =>
      resolveComposerProviderUsageSnapshot({
        provider,
        snapshots: usageQuery.data,
        querySettled: usageQuery.isSuccess || usageQuery.isError,
        queryFailed: usageQuery.isError || usageQuery.isRefetchError,
      }),
    [
      provider,
      usageQuery.data,
      usageQuery.isError,
      usageQuery.isRefetchError,
      usageQuery.isSuccess,
    ],
  );
  const model = useProviderUsageMenuModel(provider, {
    includeEmptyState: true,
    includeSupplementalData: false,
    fetchProviderData: false,
    providerSnapshot,
    isLoading: queryEnabled && usageQuery.isPending && providerSnapshot === undefined,
  });
  const contentSizeKey = composerProviderUsageContentSizeKey(model);

  useLayoutEffect(() => {
    onContentSizeChange?.();
  }, [contentSizeKey, onContentSizeChange]);

  if (!isProviderUsageSupported(provider)) {
    return null;
  }

  const presentation = deriveComposerProviderUsageTriggerPresentation(model, showReset);

  return (
    <ProviderUsageMenuPopup
      provider={provider}
      model={model}
      align="end"
      side="top"
      showTitle
      showUsageLines
    >
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="chrome"
            className="min-w-0 shrink-0 justify-start gap-1.5 px-2 tabular-nums sm:px-2.5 [&_svg]:mx-0"
            aria-label={presentation.accessibleLabel}
            title={presentation.accessibleLabel}
            data-provider-usage-state={model.state}
          />
        }
      >
        <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
        <span className="shrink-0 text-[var(--color-text-foreground)]">
          {presentation.primaryText}
        </span>
        {presentation.resetText ? (
          <span className={cn("max-w-28 truncate", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
            {presentation.resetText}
          </span>
        ) : null}
        <ChevronDownIcon aria-hidden="true" className="ms-0.5 size-3 shrink-0 opacity-60" />
      </MenuTrigger>
    </ProviderUsageMenuPopup>
  );
}
