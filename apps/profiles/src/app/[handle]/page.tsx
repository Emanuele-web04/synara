import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import { ActivityHeatmap, APP_HEATMAP_INTENSITY_CLASSES } from "@synara/profile-ui/heatmap";
import {
  deriveInitials,
  formatCompact,
  formatHourLabel,
  formatShortDate,
} from "@synara/profile-ui/formatting";
import {
  PROVIDER_GLYPHS,
  providerIconToneClassName,
  providerLabel,
} from "@synara/profile-ui/provider-icon";
import { PageShell } from "../../components/chrome";
import { ListRow, ProfileCard, StatCard } from "../../components/ProfileCard";
import { DailyAreaChart, DailyBarChart, HourBars } from "../../components/ProfileCharts";
import { activeDayCount, buildDailySeries, tokensInYear } from "../../lib/dailySeries";
import { buildHeatmapCells } from "../../lib/heatmapCells";
import { profileAccentStyle, resolveProfileAccent } from "../../lib/profileAccent";
import { formatStreak, memberSince } from "../../lib/profileFormat";
import { fetchPublicProfile, type PublicProfile } from "../../lib/publicProfile";

/** Days the Tokens and Prompts charts span. */
const CHART_WINDOW_DAYS = 30;
/** The phone heatmap's window: about four months of weeks. */
const MOBILE_HEATMAP_DAYS = 119;

type Params = { params: Promise<{ handle: string }> };

/**
 * The trysynara.com rewrite delivers `/@dylan` as the `handle` segment, so
 * the raw param arrives URL-encoded with its @ ("%40dylan"). Anything that
 * does not carry the @ is not a profile URL this app serves.
 */
function handleFromParam(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const handle = decoded.slice(1).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handle) ? handle : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const handle = handleFromParam((await params).handle);
  if (!handle) return {};
  const profile = await fetchPublicProfile(handle).catch(() => null);
  if (!profile) return {};
  const description = `${formatCompact(profile.lifetimeTokens)} tokens · ${formatCompact(profile.lifetimePrompts)} prompts on Synara`;
  return {
    title: `${profile.displayName} (@${profile.handle}) · Synara`,
    description,
    openGraph: {
      title: `${profile.displayName} (@${profile.handle})`,
      description,
    },
    // The file-convention opengraph-image registers itself; the card type is
    // the only twitter-specific bit the route can't infer.
    twitter: { card: "summary_large_image" },
  };
}

export default async function ProfilePage({ params }: Params) {
  const handle = handleFromParam((await params).handle);
  if (!handle) notFound();
  const profile = await fetchPublicProfile(handle);
  if (!profile) notFound();

  const since = memberSince(profile.createdAt);
  const series = buildDailySeries(profile.heatmap, CHART_WINDOW_DAYS, profile.localToday);
  const windowTokens = series.reduce((sum, point) => sum + point.tokens, 0);
  const windowPrompts = series.reduce((sum, point) => sum + point.prompts, 0);

  return (
    <div className="profile-accent" style={profileAccentStyle(resolveProfileAccent(profile))}>
      <PageShell>
        {/* Identity */}
        <header className="flex flex-col items-center gap-3 text-center">
          <ProfileAvatar
            initials={deriveInitials(profile.displayName)}
            color={profile.avatarColor}
            image={profile.avatarUrl ?? null}
            className="size-24 ring-4 ring-[color-mix(in_srgb,var(--info)_22%,transparent)]"
            textClassName="text-3xl"
          />
          <div className="min-w-0">
            <h1 className="truncate text-[30px] font-semibold leading-tight tracking-tight">
              {profile.displayName}
            </h1>
            <p className="mt-1 truncate text-[15px] text-muted-foreground">@{profile.handle}</p>
          </div>
          {since ? (
            <span className="rounded-full bg-[var(--tile)] px-3 py-1 text-xs text-muted-foreground">
              On Synara since {since}
            </span>
          ) : null}
        </header>

        {/* Headline numbers */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Lifetime tokens" value={formatCompact(profile.lifetimeTokens)} />
          <StatCard label="Prompts" value={formatCompact(profile.lifetimePrompts)} />
          <StatCard label="Turns" value={formatCompact(profile.lifetimeTurns)} />
          <StatCard
            label="Peak day"
            value={profile.peakDay ? formatCompact(profile.peakDay.tokens) : "—"}
            {...(profile.peakDay
              ? { note: formatShortDate(profile.peakDay.day) ?? profile.peakDay.day }
              : {})}
          />
          <StatCard label="Current streak" value={formatStreak(profile.currentStreakDays)} />
          <StatCard label="Longest streak" value={formatStreak(profile.longestStreakDays)} />
        </div>

        <ActivityCard profile={profile} />
        <TopModelsCard models={profile.models} lifetimeTokens={profile.lifetimeTokens} />

        <ProfileCard title="Tokens" detail={`Last ${CHART_WINDOW_DAYS} days`}>
          <span className="-mt-2 text-[26px] font-semibold leading-tight tracking-tight tabular-nums">
            {formatCompact(windowTokens)} tokens
          </span>
          <DailyAreaChart points={series} />
        </ProfileCard>

        <ProfileCard
          title="Prompts"
          detail={`Active ${activeDayCount(series)} of ${CHART_WINDOW_DAYS} days`}
        >
          <span className="-mt-2 text-[26px] font-semibold leading-tight tracking-tight tabular-nums">
            {formatCompact(windowPrompts)} prompts
          </span>
          <DailyBarChart points={series} />
        </ProfileCard>

        <RhythmCard profile={profile} />
      </PageShell>
    </div>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

function ActivityCard({ profile }: { profile: PublicProfile }) {
  // No renderTooltip: ActivityHeatmap falls back to a native `title`, keeping the
  // page free of client JS. Fill mode with the app's window length, so the grid
  // renders exactly like the in-app Activity section — no horizontal scroll.
  const cells = buildHeatmapCells(profile.heatmap, profile.localToday);
  // A phone fits about four months of legible cells; the full window would shrink them
  // to dots and collide the month labels.
  const recentCells = buildHeatmapCells(profile.heatmap, profile.localToday, MOBILE_HEATMAP_DAYS);
  const year = (profile.localToday ?? new Date().toISOString()).slice(0, 4);
  return (
    <ProfileCard
      title="Activity"
      detail={`${formatCompact(tokensInYear(profile.heatmap, year))} tokens in ${year}`}
    >
      <ActivityHeatmap
        cells={cells}
        fill
        radius={4}
        gap={3}
        showMonths
        monthsPosition="bottom"
        className="hidden sm:flex"
      />
      <ActivityHeatmap
        cells={recentCells}
        fill
        radius={4}
        gap={3}
        showMonths
        monthsPosition="bottom"
        className="sm:hidden"
      />
      <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        <span>Less</span>
        {APP_HEATMAP_INTENSITY_CLASSES.map((className) => (
          <span key={className} aria-hidden className={`size-2.5 rounded-[3px] ${className}`} />
        ))}
        <span>More</span>
      </div>
    </ProfileCard>
  );
}

// ── Models ─────────────────────────────────────────────────────────────

function ProviderGlyph({ provider, className }: { provider: string; className: string }) {
  const Glyph = (PROVIDER_GLYPHS as Partial<Record<string, (typeof PROVIDER_GLYPHS)["codex"]>>)[
    provider
  ];
  return Glyph ? (
    <Glyph aria-hidden className={`shrink-0 ${className} ${providerIconToneClassName(provider)}`} />
  ) : (
    <span aria-hidden className={`shrink-0 rounded-md bg-muted ${className}`} />
  );
}

function TopModelsCard({
  models,
  lifetimeTokens,
}: {
  models: PublicProfile["models"];
  lifetimeTokens: number;
}) {
  if (models.length === 0) return null;
  const total = Math.max(1, lifetimeTokens);
  const ranked = models.toSorted((left, right) => right.tokens - left.tokens);
  const podium = ranked.slice(0, 3);

  return (
    <ProfileCard title="Models" detail={`${models.length} used`}>
      <ol className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3">
        {podium.map((row, index) => (
          <li
            key={`${row.provider}/${row.model}/${row.reasoning ?? ""}`}
            className="relative flex min-w-0 flex-col gap-2 rounded-2xl bg-background/70 px-4 py-3.5 dark:bg-white/[0.04]"
          >
            <span className="absolute right-3 top-2.5 text-[11px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <ProviderGlyph provider={row.provider} className="size-5" />
            <span className="truncate text-[15px] font-medium">{row.model}</span>
            <span className="truncate text-xs tabular-nums text-muted-foreground">
              {formatCompact(row.tokens)} · {Math.round((row.tokens / total) * 100)}%
            </span>
          </li>
        ))}
      </ol>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {ranked.map((row) => {
          const percent = Math.round((row.tokens / total) * 100);
          return (
            <li
              key={`${row.provider}/${row.model}/${row.reasoning ?? ""}`}
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderGlyph provider={row.provider} className="size-3.5" />
                  <span className="truncate">
                    {row.model}
                    <span className="text-muted-foreground">
                      {" · "}
                      {providerLabel(row.provider)}
                      {row.reasoning ? ` · ${row.reasoning}` : ""}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-[var(--info)]"
                  style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </ProfileCard>
  );
}

// ── Rhythm ─────────────────────────────────────────────────────────────

function RhythmCard({ profile }: { profile: PublicProfile }) {
  const byProvider = new Map<string, number>();
  const byReasoning = new Map<string, number>();
  for (const row of profile.models) {
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.tokens);
    if (row.reasoning) {
      byReasoning.set(row.reasoning, (byReasoning.get(row.reasoning) ?? 0) + row.turns);
    }
  }
  const totalTokens = Math.max(1, profile.lifetimeTokens);
  const totalTurns = Math.max(
    1,
    profile.models.reduce((sum, row) => sum + row.turns, 0),
  );
  const top = (entries: Map<string, number>) =>
    [...entries.entries()].toSorted((a, b) => b[1] - a[1])[0];
  const topProvider = top(byProvider);
  const topReasoning = top(byReasoning);
  const topHour = profile.hours.reduce<{ hour: number; prompts: number } | null>(
    (best, entry) =>
      entry.prompts > 0 && (best === null || entry.prompts > best.prompts) ? entry : best,
    null,
  );

  return (
    <ProfileCard
      title="Rhythm"
      detail={topHour ? `Most active at ${formatHourLabel(topHour.hour)}` : undefined}
    >
      <HourBars hours={profile.hours} />
      <dl className="m-0 flex flex-col">
        <ListRow
          label="Most used provider"
          value={
            topProvider
              ? `${providerLabel(topProvider[0])} · ${Math.round((topProvider[1] / totalTokens) * 100)}%`
              : "—"
          }
        />
        <ListRow
          label="Most used reasoning"
          value={
            topReasoning
              ? `${capitalize(topReasoning[0])} · ${Math.round((topReasoning[1] / totalTurns) * 100)}%`
              : "—"
          }
        />
        <ListRow label="Most active hour" value={topHour ? formatHourLabel(topHour.hour) : "—"} />
      </dl>
    </ProfileCard>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
