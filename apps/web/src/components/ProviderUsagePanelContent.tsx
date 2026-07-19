// FILE: ProviderUsagePanelContent.tsx
// Purpose: Render a provider usage summary panel that can show both classic
// rate-limit rows and archive-derived local usage lines in the same popover.

import type { ProviderKind } from "@synara/contracts";
import { providerUsageLabel } from "@synara/shared/providerUsage";
import { memo, useMemo } from "react";

import { ExternalLinkIcon, TriangleAlertIcon } from "~/lib/icons";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import { cn } from "~/lib/utils";

import { ProviderUsageLimitRows } from "./ProviderUsageLimitRows";
import { ProviderUsageLineList } from "./ProviderUsageLineList";

export { providerUsageLabel };

export const PROVIDER_USAGE_PILL_CLASS_NAME =
  "shrink-0 rounded-full px-2 py-1 text-[11px] font-medium leading-none";

export function ProviderUsagePlanPill({ planName }: { planName: string }) {
  return (
    <span
      className={cn(
        PROVIDER_USAGE_PILL_CLASS_NAME,
        "max-w-32 truncate bg-muted text-muted-foreground",
      )}
      title={planName}
    >
      {planName}
    </span>
  );
}

export const ProviderUsagePanelContent = memo(function ProviderUsagePanelContent(props: {
  provider: ProviderKind | null | undefined;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines?: ReadonlyArray<OpenUsageUsageLine> | undefined;
  planName?: string | null | undefined;
  notice?: string | null | undefined;
  isLoading?: boolean | undefined;
  emptyMessage?: string | null | undefined;
  learnMoreHref?: string | null | undefined;
  showUsageLines?: boolean | undefined;
  showTitle?: boolean | undefined;
  showLearnMore?: boolean | undefined;
  className?: string | undefined;
}) {
  const visibleRows = useMemo(
    () => deriveProviderUsageDisplayRows(props.rateLimits),
    [props.rateLimits],
  );
  const learnMoreHref = useMemo(
    () =>
      props.learnMoreHref ??
      deriveRateLimitLearnMoreHref(props.rateLimits) ??
      deriveProviderUsageLearnMoreHref(props.provider),
    [props.learnMoreHref, props.provider, props.rateLimits],
  );

  return (
    <div className={cn("space-y-2", props.className)}>
      {props.showTitle !== false ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[length:var(--app-font-size-chat-meta,10px)] font-medium text-muted-foreground">
            {providerUsageLabel(props.provider)}
          </div>
          {props.planName ? <ProviderUsagePlanPill planName={props.planName} /> : null}
        </div>
      ) : null}
      {props.notice ? (
        <p className="flex items-start gap-1.5 text-[length:var(--app-font-size-chat-meta,10px)] leading-relaxed text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{props.notice}</span>
        </p>
      ) : null}
      <ProviderUsageLimitRows rows={visibleRows} surface="popover" />
      {props.showUsageLines !== false && props.usageLines && props.usageLines.length > 0 ? (
        <ProviderUsageLineList
          className={cn(visibleRows.length > 0 && "pt-0.5")}
          lines={props.usageLines}
          surface="popover"
        />
      ) : visibleRows.length === 0 && props.isLoading ? (
        <p className="text-[length:var(--app-font-size-chat-meta,10px)] leading-relaxed text-muted-foreground">
          Checking usage for the selected provider…
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="text-[length:var(--app-font-size-chat-meta,10px)] leading-relaxed text-muted-foreground">
          {props.emptyMessage ??
            (props.provider
              ? "No usage data was found yet for the selected provider."
              : "No usage data was found yet.")}
        </p>
      ) : null}
      {props.showLearnMore === true && learnMoreHref ? (
        <a
          href={learnMoreHref}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 pt-0.5 text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground transition-colors hover:text-foreground"
        >
          Learn more
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
    </div>
  );
});
