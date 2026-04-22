// FILE: ProviderUsagePanelContent.tsx
// Purpose: Render a provider usage summary panel that can show both classic
// rate-limit rows and archive-derived local usage lines in the same popover.

import type { ProviderKind } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { ExternalLinkIcon } from "~/lib/icons";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  deriveVisibleRateLimitRows,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import { cn } from "~/lib/utils";

import { RateLimitSummaryList } from "./RateLimitSummaryList";

export function providerUsageLabel(provider: ProviderKind | null | undefined): string {
  if (provider === "codex") return "Codex usage";
  if (provider === "claudeAgent") return "Claude usage";
  if (provider === "gemini") return "Gemini usage";
  return "Usage";
}

export const ProviderUsagePanelContent = memo(function ProviderUsagePanelContent(props: {
  provider: ProviderKind | null | undefined;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines?: ReadonlyArray<OpenUsageUsageLine> | undefined;
  isLoading?: boolean | undefined;
  learnMoreHref?: string | null | undefined;
  showTitle?: boolean | undefined;
  className?: string | undefined;
}) {
  const visibleRows = useMemo(
    () => deriveVisibleRateLimitRows(props.rateLimits),
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
        <div className="text-[length:var(--app-font-size-chat-meta,10px)] font-medium text-muted-foreground">
          {providerUsageLabel(props.provider)}
        </div>
      ) : null}
      {visibleRows.length > 0 ? <RateLimitSummaryList rateLimits={props.rateLimits} /> : null}
      {props.usageLines && props.usageLines.length > 0 ? (
        <div className="space-y-1.5">
          {props.usageLines.map((line) => (
            <div
              key={`${line.label}:${line.value}`}
              className="space-y-0.5 text-[length:var(--app-font-size-chat,12px)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{line.label}</span>
                <span className="text-right text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground">
                  {line.value}
                </span>
              </div>
              {line.subtitle ? (
                <div className="text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground/80">
                  {line.subtitle}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : visibleRows.length === 0 && props.isLoading ? (
        <p className="text-[length:var(--app-font-size-chat-meta,10px)] leading-relaxed text-muted-foreground">
          Scanning local usage data for the selected provider.
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="text-[length:var(--app-font-size-chat-meta,10px)] leading-relaxed text-muted-foreground">
          {props.provider
            ? "No local usage data was found yet for the selected provider."
            : "No local usage data was found yet."}
        </p>
      ) : null}
      {learnMoreHref ? (
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
