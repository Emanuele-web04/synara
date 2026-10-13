// FILE: ProfileSettingsPanel.tsx
// Purpose: Local-first profile / stats dashboard rendered inside Settings → Profile. Core
// stats render instantly from a fast SQL RPC; lifetime/peak token figures and the tokens/day
// heatmap stream in from a second DB-backed RPC. Centered, low-chrome layout
// with an explicit edit mode for the local name + handle.
// Layer: web profile feature (settings panel body).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ProfileStats, type ProfileTokenStats, type ProviderKind } from "@synara/contracts";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { CentralIcon } from "~/lib/central-icons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ActivityHeatmap } from "../profile/ActivityHeatmap";
import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTopProvider,
} from "../profile/profileSelectors";
import { ProfileUsageCoverage } from "../profile/ProfileUsageCoverage";
import { ShareDialog } from "../profile/ShareDialog";
import { EditProfileDialog } from "../profile/EditProfileDialog";
import { useProfileHandle } from "../profile/useProfileHandle";
import { useProfileName } from "../profile/useProfileName";
import { useProfileAvatarColor } from "../profile/useProfileAvatarColor";
import { useProfileAvatarImage } from "../profile/useProfileAvatarImage";
import { ProfileAvatar } from "../profile/ProfileAvatar";
import {
  formatCompact,
  formatDays,
  formatNumber,
  formatProviderLabel,
  formatProfileUsageBasis,
  toDisplayName,
} from "../profile/profileFormatting";
import { useTranslation, t } from "~/i18n";

export function ProfileSettingsPanel() {
  const { t } = useTranslation();

  const coreQuery = useQuery(serverProfileStatsQueryOptions());
  const tokenQuery = useQuery(serverProfileTokenStatsQueryOptions());

  if (coreQuery.isPending) {
    return <ProfileSkeleton />;
  }
  if (coreQuery.isError || !coreQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-ui leading-snug text-muted-foreground">
          {t("Couldn’t load your local stats.")}
        </p>
        <Button variant="outline" size="sm" onClick={() => void coreQuery.refetch()}>
          {t("Try again")}
        </Button>
      </div>
    );
  }

  return (
    <ProfileContent
      stats={coreQuery.data}
      tokenStats={tokenQuery.data ?? null}
      tokensPending={tokenQuery.isPending}
    />
  );
}

function ProfileContent({
  stats,
  tokenStats,
  tokensPending,
}: {
  stats: ProfileStats;
  tokenStats: ProfileTokenStats | null;
  tokensPending: boolean;
}) {
  const { t, formatLocale } = useTranslation();

  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const defaultName = toDisplayName(stats.identity.homeDirBasename);
  const { name, setName } = useProfileName(defaultName);
  const { handle, setHandle } = useProfileHandle(stats.identity.defaultHandle);
  const { color: avatarColor, setColor: setAvatarColor } = useProfileAvatarColor();
  const { image: avatarImage, setImage: setAvatarImage } = useProfileAvatarImage();

  // Tokens/day when available, prompts/day otherwise — shared with ShareCard.
  const heatmap = selectProfileHeatmap(stats, tokenStats);
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  const modelUsage = selectProfileModelUsage(stats, tokenStats);
  const peakHourLabel = formatPeakHourLabel(stats.activeHours.startHour, formatLocale);
  const mostWorkedProjectLabel = formatMostWorkedProjectLabel(
    stats.mostWorkedProject,
    formatLocale,
  );

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {/* Action row */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
          <CentralIcon name="share-os" />
          {t("Share")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <CentralIcon name="pencil" />
          {t("Edit")}
        </Button>
      </div>

      {/* Centered identity header */}
      <header className="flex flex-col items-center gap-3 text-center">
        <ProfileAvatar
          initials={stats.identity.initials}
          color={avatarColor}
          image={avatarImage}
          className="size-16 shadow-sm"
          textClassName="text-xl"
        />
        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
          <div className="flex items-center gap-1.5 text-ui leading-snug text-muted-foreground">
            <span>{handle}</span>
            <span aria-hidden>·</span>
            <span className="rounded-full border px-1.5 py-px text-ui leading-snug text-muted-foreground">
              Synara
            </span>
          </div>
        </div>
      </header>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        <StatTile
          label={t("Lifetime tokens")}
          value={
            tokensPending
              ? null
              : formatCompact(tokenStats?.lifetimeTotalTokens ?? null, formatLocale)
          }
        />
        <StatTile
          label={t("Peak day")}
          value={
            tokensPending ? null : formatCompact(tokenStats?.peakDayTokens ?? null, formatLocale)
          }
        />
        <StatTile
          label={t("Total prompts")}
          value={formatNumber(stats.activity.totalPromptsSent, formatLocale)}
        />
        <StatTile
          label={t("Current streak")}
          value={formatDays(stats.activity.currentStreakDays, formatLocale)}
        />
        <StatTile
          label={t("Longest streak")}
          value={formatDays(stats.activity.longestStreakDays, formatLocale)}
        />
      </div>

      {/* Heatmap */}
      {stats.providerModels.some((entry) => entry.provider === "claudeAgent") ||
      tokenStats?.providers.includes("claudeAgent") ? (
        <p className="text-ui leading-snug text-muted-foreground">
          {t(
            "Claude token totals use verifiable records. Older history and unfinished turns may be incomplete.",
          )}
        </p>
      ) : null}
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-ui-lg font-medium">{t("Activity")}</h3>
        {tokensPending ? (
          <Skeleton className="h-28 w-full rounded-lg" />
        ) : (
          <ActivityHeatmap
            cells={heatmap.cells}
            fill
            radius={5}
            gap={3}
            tooltip
            tooltipUnit={heatmap.unit}
            showMonths
            monthsPosition="bottom"
          />
        )}
      </section>

      {/* Insights + plugins */}
      <div className="grid gap-x-12 gap-y-7 md:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h3 className="text-ui-lg font-medium">{t("Activity insights")}</h3>
          <dl className="flex flex-col gap-2.5">
            <InsightRow
              label={t("Most used provider")}
              value={
                topProvider.provider
                  ? `${formatProviderLabel(topProvider.provider)}${
                      topProvider.percent !== null
                        ? t(" · {{percent}}% of {{metric}}", {
                            percent: new Intl.NumberFormat(formatLocale, {
                              maximumFractionDigits: 1,
                            }).format(topProvider.percent),
                            metric: formatProfileUsageBasis(topProvider.metric, formatLocale),
                          })
                        : ""
                    }`
                  : "—"
              }
            />
            <InsightRow
              label={t("Most used reasoning")}
              value={
                stats.insights.topReasoning
                  ? `${capitalize(stats.insights.topReasoning)}${
                      stats.insights.topReasoningPercent !== null
                        ? ` · ${stats.insights.topReasoningPercent}%`
                        : ""
                    }`
                  : "—"
              }
            />
            <InsightRow label={t("Most active hour")} value={peakHourLabel} />
            <InsightRow label={t("Most worked project")} value={mostWorkedProjectLabel} />
            <InsightRow
              label={t("Skills explored")}
              value={formatNumber(stats.insights.skillsExplored, formatLocale)}
            />
            <InsightRow
              label={t("Total skills used")}
              value={formatNumber(stats.insights.totalSkillsUsed, formatLocale)}
            />
            <InsightRow
              label={t("Total threads")}
              value={formatNumber(stats.activity.totalThreads, formatLocale)}
            />
          </dl>
          <ProfileUsageCoverage unavailableProviders={topProvider.unavailableProviders} />
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-ui-lg font-medium">{t("Most used plugins")}</h3>
          {stats.skills.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {stats.skills.slice(0, 6).map((skill) => (
                <li
                  key={`${skill.kind}:${skill.name}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60">
                      <CentralIcon
                        name={skill.kind === "agent" ? "agent" : "building-blocks"}
                        className="size-3"
                      />
                    </span>
                    <span className="truncate text-ui leading-snug">{skill.displayName}</span>
                  </span>
                  <span className="shrink-0 text-ui leading-snug tabular-nums text-muted-foreground">
                    {formatNumber(skill.runCount, formatLocale)} {t("runs")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ui leading-snug text-muted-foreground">
              {t("No skills or agents used yet.")}
            </p>
          )}
        </section>
      </div>

      {/* Model usage */}
      <section className="flex flex-col gap-3">
        <h3 className="text-ui-lg font-medium">{t("Model usage")}</h3>
        <p className="text-ui leading-snug text-muted-foreground">
          {t("Share of")} {formatProfileUsageBasis(modelUsage.metric, formatLocale)}.
        </p>
        {modelUsage.entries.length > 0 ? (
          <ul className="grid grid-cols-1 gap-x-12 gap-y-3 sm:grid-cols-2">
            {modelUsage.entries.slice(0, 6).map((entry) => (
              <ModelUsageRow
                key={`${entry.instanceId}:${entry.model}`}
                provider={entry.provider}
                model={entry.model}
                percent={entry.percent}
              />
            ))}
          </ul>
        ) : (
          <p className="text-ui leading-snug text-muted-foreground">
            {t("No model activity yet.")}
          </p>
        )}
        <ProfileUsageCoverage unavailableProviders={modelUsage.unavailableProviders} />
      </section>

      <ShareDialog
        stats={stats}
        tokenStats={tokenStats}
        displayName={name}
        handle={handle}
        avatarColor={avatarColor}
        avatarImage={avatarImage}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <EditProfileDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initials={stats.identity.initials}
        name={name}
        handle={handle}
        avatarColor={avatarColor}
        avatarImage={avatarImage}
        onSave={({
          name: nextName,
          handle: nextHandle,
          avatarColor: nextColor,
          avatarImage: nextImage,
        }) => {
          setName(nextName);
          setHandle(nextHandle);
          setAvatarColor(nextColor);
          setAvatarImage(nextImage);
        }}
      />
    </div>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-3">
      {value === null ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className="text-ui-lg leading-snug font-normal tabular-nums text-foreground">
          {value}
        </span>
      )}
      <span className="text-ui leading-snug font-normal text-muted-foreground">{label}</span>
    </div>
  );
}

function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-ui leading-snug text-muted-foreground">{label}</dt>
      <dd className="truncate text-ui leading-snug font-normal tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatHour(hour: number, formatLocale: string): string {
  const normalized = ((hour % 24) + 24) % 24;
  return new Intl.DateTimeFormat(formatLocale, { hour: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 0, 1, normalized)),
  );
}

function formatPeakHourLabel(startHour: number | null, formatLocale: string): string {
  return startHour === null ? "—" : formatHour(startHour, formatLocale);
}

function formatMostWorkedProjectLabel(
  project: ProfileStats["mostWorkedProject"],
  formatLocale: string,
): string {
  if (!project) {
    return "—";
  }
  const promptLabel = project.promptCount === 1 ? t("prompt") : t("prompts");
  return t("{{value0}} · {{value1}} {{value2}}", {
    value0: project.title,
    value1: formatNumber(project.promptCount, formatLocale),
    value2: promptLabel,
  });
}

function ModelUsageRow({
  provider,
  model,
  percent,
}: {
  provider: ProviderKind | "unknown";
  model: string;
  percent: number;
}) {
  const { formatLocale } = useTranslation();
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui leading-snug">
        <span className="flex min-w-0 items-center gap-2">
          {provider !== "unknown" ? (
            <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
          ) : (
            <CentralIcon name="chart-2" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{model}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 }).format(percent)}%
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--info)]"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
    </li>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col items-center gap-7">
      <Skeleton className="size-16 rounded-full" />
      <div className="flex flex-col items-center gap-1.5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-[72px] w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid w-full gap-7 md:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
