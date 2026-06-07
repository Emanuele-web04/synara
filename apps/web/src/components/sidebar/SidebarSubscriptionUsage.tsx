// FILE: SidebarSubscriptionUsage.tsx
// Purpose: Show CrossUsage subscription usage for all enabled providers in the sidebar.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { HiOutlineChartBarSquare } from "react-icons/hi2";

import { ProviderIcon } from "~/components/ProviderIcon";
import { toastManager } from "~/components/ui/toast";
import { SidebarSectionToolbar } from "~/components/SidebarSectionToolbar";
import { SidebarGlyph } from "~/components/sidebarGlyphs";
import { SidebarLeadingIcon } from "~/components/SidebarLeadingIcon";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { launchCrossUsage } from "~/lib/crossUsageLaunch";
import { openUsageAllProvidersQueryOptions, openUsageQueryKeys } from "~/lib/openUsageReactQuery";
import {
  formatOpenUsageProgressSummary,
  openUsageProgressPercent,
  openUsageProviderDisplayName,
  openUsageSidebarProgressLines,
  type OpenUsageProgressLine,
  type OpenUsageProviderSnapshot,
} from "~/lib/openUsageSnapshots";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";

import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";

const CROSSUSAGE_REFETCH_DELAYS_MS = [2_000, 5_000, 10_000] as const;

function UsageProgressRow({ line }: { line: OpenUsageProgressLine }) {
  const usedPercent = openUsageProgressPercent(line);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
        <span className="truncate text-muted-foreground/82">{line.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground/72">
          {formatOpenUsageProgressSummary(line)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted/55"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPercent}
        aria-label={`${line.label} usage`}
      >
        <div
          className="h-full rounded-full bg-primary/78 transition-[width] duration-300 ease-out"
          style={{
            width: `${usedPercent}%`,
            ...(line.color ? { backgroundColor: line.color } : {}),
          }}
        />
      </div>
    </div>
  );
}

const SidebarUsageProviderCard = memo(function SidebarUsageProviderCard({
  snapshot,
}: {
  snapshot: OpenUsageProviderSnapshot;
}) {
  const progressLines = useMemo(() => openUsageSidebarProgressLines(snapshot), [snapshot]);
  const displayName = openUsageProviderDisplayName(snapshot);

  if (progressLines.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/35 bg-background/35 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {snapshot.providerKind ? (
          <ProviderIcon
            provider={snapshot.providerKind}
            className="size-3.5 shrink-0 text-muted-foreground/88"
            aria-hidden
          />
        ) : (
          <span className="size-3.5 shrink-0 rounded-full bg-muted/70" aria-hidden />
        )}
        <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/92">
          {displayName}
        </div>
      </div>

      <div className="space-y-2.5">
        {progressLines.map((line) => (
          <UsageProgressRow key={`${snapshot.providerId}:${line.label}`} line={line} />
        ))}
      </div>
    </div>
  );
});

export function SidebarSubscriptionUsage({ className }: { className?: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const queryClient = useQueryClient();
  const usageQuery = useQuery(openUsageAllProvidersQueryOptions());
  const snapshots = useMemo(
    () =>
      (usageQuery.data ?? []).filter((snapshot) =>
        snapshot.lines.some((line) => line.type === "progress"),
      ),
    [usageQuery.data],
  );
  const hasSnapshots = snapshots.length > 0;

  const scheduleUsageRefetches = useCallback(() => {
    for (const delayMs of CROSSUSAGE_REFETCH_DELAYS_MS) {
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: openUsageQueryKeys.providers });
      }, delayMs);
    }
  }, [queryClient]);

  const handleOpenCrossUsage = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(true);
      if (isLaunching) {
        return;
      }

      setIsLaunching(true);
      void launchCrossUsage()
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: openUsageQueryKeys.providers });
          scheduleUsageRefetches();
        })
        .catch((error: unknown) => {
          toastManager.add({
            title: "Could not start CrossUsage",
            description:
              error instanceof Error ? error.message : "Failed to run the usage launcher.",
            type: "error",
          });
          void queryClient.invalidateQueries({ queryKey: openUsageQueryKeys.providers });
          scheduleUsageRefetches();
        })
        .finally(() => {
          setIsLaunching(false);
        });
    },
    [isLaunching, queryClient, scheduleUsageRefetches],
  );

  return (
    <div className={cn("group/collapsible", className)}>
      <div className="group/project-header relative">
        <SidebarMenuButton
          size="sm"
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            "cursor-pointer",
          )}
          onClick={() => setExpanded((current) => !current)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setExpanded((current) => !current);
          }}
        >
          <SidebarLeadingIcon size="sm">
            <SidebarGlyph icon={HiOutlineChartBarSquare} variant="chrome" />
          </SidebarLeadingIcon>
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
              Subscriptions
            </span>
            {hasSnapshots ? (
              <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/52">
                {snapshots.length}
              </span>
            ) : null}
          </div>
        </SidebarMenuButton>
        <SidebarSectionToolbar placement="overlay">
          <button
            type="button"
            className="inline-flex h-[18px] shrink-0 cursor-pointer items-center rounded px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground/76 transition-colors hover:text-foreground/88 disabled:cursor-default disabled:opacity-60"
            aria-label="Open CrossUsage"
            disabled={isLaunching}
            onClick={handleOpenCrossUsage}
          >
            Open
          </button>
        </SidebarSectionToolbar>
      </div>

      <div className={cn(disclosureShellClassName(expanded), "pt-1")}>
        <div className={DISCLOSURE_INNER_CLASS}>
          <div className={cn("space-y-2 px-1", disclosureContentClassName(expanded))}>
            {snapshots.map((snapshot) => (
              <SidebarUsageProviderCard key={snapshot.providerId} snapshot={snapshot} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
