// FILE: ProviderUsageMenuControl.tsx
// Purpose: Shared provider-usage chip/menu used in the chat header and Environment panel.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerGetProviderUsageSnapshotResult,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { providerUsageNeedsAuthDetail } from "@synara/shared/providerUsage";
import { useMemo, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import {
  deriveProviderUsageDisplayRows,
  selectPrimaryProviderUsageDisplayRow,
  type ProviderUsageDisplayRow,
} from "~/lib/providerUsageDisplay";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { ChatHeaderButton } from "./chat/chatHeaderControls";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import { Menu, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const NO_USAGE_THREADS = [] as const;

export interface ProviderUsageMenuModel {
  menuTitle: string;
  primaryRow: ProviderUsageDisplayRow | null;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines: ReadonlyArray<OpenUsageUsageLine>;
  planName: string | undefined;
  notice: string | undefined;
  state: ProviderUsageMenuState;
  detail: string | undefined;
  isLoading: boolean;
}

export interface ProviderUsageMenuModelWithPrimary extends ProviderUsageMenuModel {
  primaryRow: ProviderUsageDisplayRow;
}

export type ProviderUsageMenuState =
  | "ready"
  | "loading"
  | "needs-auth"
  | "unsupported"
  | "error"
  | "no-data";

export interface ProviderUsageMenuModelInput {
  provider: ProviderKind;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines: ReadonlyArray<OpenUsageUsageLine>;
  planName?: string | null | undefined;
  notice: string | undefined;
  isLoading: boolean;
  snapshotStatus: ServerProviderUsageSnapshot["status"] | null;
  snapshotDetail: string | null;
}

function providerUsageMenuState(input: ProviderUsageMenuModelInput): ProviderUsageMenuState {
  if (input.snapshotStatus && input.snapshotStatus !== "ok") {
    return input.snapshotStatus;
  }
  if (input.isLoading) {
    return "loading";
  }
  if (input.rateLimits.length > 0 || input.usageLines.length > 0) {
    return "ready";
  }
  return "no-data";
}

function providerUsageMenuDetail(
  provider: ProviderKind,
  state: ProviderUsageMenuState,
  detail: string | null,
): string | undefined {
  if (detail) {
    return detail;
  }
  switch (state) {
    case "needs-auth":
      return providerUsageNeedsAuthDetail(provider);
    case "unsupported":
      return "This provider does not expose usage data that Synara can read.";
    case "error":
      return "Usage is currently unavailable.";
    case "no-data":
      return "No usage data has been reported yet.";
    default:
      return undefined;
  }
}

export function deriveProviderUsageMenuModel(
  input: ProviderUsageMenuModelInput,
): ProviderUsageMenuModel {
  const usageRows = deriveProviderUsageDisplayRows(input.rateLimits);
  const primaryRow = selectPrimaryProviderUsageDisplayRow(usageRows);
  const state = providerUsageMenuState(input);

  return {
    menuTitle: `${PROVIDER_DISPLAY_NAMES[input.provider]} usage`,
    primaryRow,
    rateLimits: input.rateLimits,
    usageLines: input.usageLines,
    planName: input.planName?.trim() || undefined,
    notice: input.notice,
    state,
    detail: providerUsageMenuDetail(input.provider, state, input.snapshotDetail),
    isLoading: input.isLoading,
  };
}

interface ProviderUsageMenuModelOptions {
  fetchProviderData?: boolean;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  includeEmptyState?: boolean;
  isLoading?: boolean;
  includeSupplementalData?: boolean | undefined;
}

export function useProviderUsageMenuModel(
  provider: ProviderKind,
): ProviderUsageMenuModelWithPrimary | null;
export function useProviderUsageMenuModel(
  provider: ProviderKind,
  options: ProviderUsageMenuModelOptions & { includeEmptyState: true },
): ProviderUsageMenuModel;
export function useProviderUsageMenuModel(
  provider: ProviderKind,
  options: ProviderUsageMenuModelOptions = {},
): ProviderUsageMenuModel | null {
  const { settings } = useAppSettings();
  const selectAllThreads = useMemo(
    () =>
      options.includeSupplementalData === false
        ? () => NO_USAGE_THREADS
        : createAllThreadsSelector(),
    [options.includeSupplementalData],
  );
  const threads = useStore(selectAllThreads);
  const usageSummary = useProviderUsageSummary({
    provider,
    threads,
    codexHomePath: settings.codexHomePath || null,
    fetchProviderData: options.fetchProviderData ?? false,
    includeSupplementalData: options.includeSupplementalData,
    providerSnapshot: options.providerSnapshot,
  });
  const model = useMemo(
    () =>
      deriveProviderUsageMenuModel({
        provider,
        rateLimits: usageSummary.rateLimits,
        usageLines: usageSummary.usageLines,
        planName: usageSummary.planName,
        notice: usageSummary.usageNotice,
        isLoading: options.isLoading ?? usageSummary.isLoading,
        snapshotStatus: usageSummary.snapshotStatus,
        snapshotDetail: usageSummary.snapshotDetail,
      }),
    [options.isLoading, provider, usageSummary],
  );

  if (!model.primaryRow && options.includeEmptyState !== true) {
    return null;
  }
  return model;
}

export function ProviderUsageMenuPopup({
  provider,
  model,
  align = "end",
  side = "bottom",
  showTitle = false,
  showUsageLines = false,
  showLearnMore = false,
  children,
}: {
  provider: ProviderKind;
  model: ProviderUsageMenuModel;
  align?: "start" | "end";
  side?: "top" | "bottom";
  showTitle?: boolean;
  showUsageLines?: boolean;
  showLearnMore?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu modal={false}>
      {children}
      <ComposerPickerMenuPopup align={align} side={side} className="w-64 min-w-64">
        <ProviderUsagePanelContent
          provider={provider}
          rateLimits={model.rateLimits}
          usageLines={model.usageLines}
          planName={model.planName}
          notice={model.notice}
          isLoading={model.isLoading}
          emptyMessage={model.detail}
          showUsageLines={showUsageLines}
          showTitle={showTitle}
          showLearnMore={showLearnMore}
          className="px-2 pb-1 pt-1"
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function ProviderUsageMenuControl({ provider }: { provider: ProviderKind }) {
  const model = useProviderUsageMenuModel(provider);

  if (!model) {
    return null;
  }

  return (
    <ProviderUsageMenuPopup provider={provider} model={model}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ChatHeaderButton
                  type="button"
                  tone="plain"
                  className="gap-1.5 px-2"
                  aria-label={model.menuTitle}
                />
              }
            >
              <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
              <span className="truncate font-normal">{model.primaryRow.remainingLabel}</span>
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">{model.menuTitle}</TooltipPopup>
      </Tooltip>
    </ProviderUsageMenuPopup>
  );
}
