import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import { APP_HEATMAP_INTENSITY_CLASSES } from "@synara/profile-ui/heatmap";
import { deriveInitials, formatCompact } from "@synara/profile-ui/formatting";
import { PROVIDER_GLYPHS, providerIconToneClassName } from "@synara/profile-ui/provider-icon";
import { SOCIAL_GLYPHS } from "@synara/profile-ui/social-icon";
import {
  SOCIAL_LINK_PLATFORMS,
  type SocialLinkPlatform,
  sanitizeSocialLinks,
  socialLinkLabel,
  socialProfileUrl,
} from "@synara/shared/socialLinks";
import { SiteFooter, SiteNav } from "../../components/chrome";
import { ProfileSection, Stat } from "../../components/ProfileCard";
import {
  DailyAreaChart,
  DailyBarChart,
  HourArc,
  type ModelShare,
  ModelShareRing,
  ProfileHeatmap,
  WeekCapsules,
} from "../../components/ProfileCharts";
import { ShareProfileButton } from "../../components/ShareProfileButton";
import { activeDayCount, buildDailySeries, tokensInYear } from "../../lib/dailySeries";
import { buildCalendarYearCells, buildHeatmapCells, weeklyTotals } from "../../lib/heatmapCells";
import { groupModelUsage, type ModelUsageGroup } from "../../lib/modelUsage";
import { profileAccentStyle, resolveProfileAccent } from "../../lib/profileAccent";
import { formatStreakShort, joinedAgo } from "../../lib/profileFormat";
import { fetchPublicProfile, type PublicProfile } from "../../lib/publicProfile";

/** Days the Tokens and Prompts charts span. */
const CHART_WINDOW_DAYS = 30;
/** Models the ring names before folding the rest into "Other models". */
const RING_MODELS = 3;
/** The page's content width; nav and footer line up with it. */
const CONTENT_WIDTH = "max-w-[1040px]";

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

  const series = buildDailySeries(profile.heatmap, CHART_WINDOW_DAYS, profile.localToday);
  const windowTokens = series.reduce((sum, point) => sum + point.tokens, 0);
  const windowPrompts = series.reduce((sum, point) => sum + point.prompts, 0);
  const cells = buildHeatmapCells(profile.heatmap, profile.localToday);
  const weeks = weeklyTotals(cells);
  const groups = groupModelUsage(profile.models);
  const activeToday =
    profile.localToday !== undefined &&
    profile.heatmap.some((day) => day.day === profile.localToday && day.tokens > 0);

  return (
    <div
      className="profile-accent flex min-h-dvh flex-col"
      style={profileAccentStyle(resolveProfileAccent(profile))}
    >
      <SiteNav />
      <main
        className={`mx-auto flex w-full ${CONTENT_WIDTH} flex-1 gap-12 px-5 pb-16 pt-10 sm:px-6 sm:pt-16`}
      >
        {/* The left rail: when they joined and where else to find them. Phones get the
            same facts as a row under the name instead. */}
        <aside className="hidden w-[180px] shrink-0 flex-col gap-6 pt-[92px] lg:flex">
          <JoinedLine profile={profile} />
          <SocialLinkList links={profile.socialLinks} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-11">
          <header className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="relative shrink-0">
                  <ProfileAvatar
                    initials={deriveInitials(profile.displayName)}
                    color={profile.avatarColor}
                    image={profile.avatarUrl ?? null}
                    className="size-12"
                    textClassName="text-lg"
                  />
                  {activeToday ? (
                    <span
                      role="img"
                      aria-label="Active today"
                      className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-[var(--info)] ring-[3px] ring-background"
                    />
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-col">
                  <h1 className="truncate text-xl font-semibold leading-tight tracking-tight">
                    {profile.displayName}
                  </h1>
                  <p className="truncate text-[13px] text-muted-foreground">@{profile.handle}</p>
                </div>
              </div>
              <ShareProfileButton title={`${profile.displayName} on Synara`} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:hidden">
              <JoinedLine profile={profile} />
              <SocialLinkList links={profile.socialLinks} compact />
            </div>
          </header>

          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
            <Stat label="Tokens" value={formatCompact(profile.lifetimeTokens)} />
            <Stat label="Prompts" value={formatCompact(profile.lifetimePrompts)} />
            <Stat label="Longest streak" value={formatStreakShort(profile.longestStreakDays)} />
            <Stat label="Current streak" value={formatStreakShort(profile.currentStreakDays)} />
          </div>

          <ActivitySection profile={profile} />
          <TopModels groups={groups} lifetimeTokens={profile.lifetimeTokens} />

          {groups.length > 0 || profile.hours.some((entry) => entry.prompts > 0) ? (
            <div className="grid grid-cols-1 gap-11 sm:grid-cols-2 sm:gap-8">
              {groups.length > 0 ? (
                <ProfileSection title="Share of tokens">
                  <ModelShareRing
                    shares={ringShares(groups)}
                    total={groups.reduce((sum, group) => sum + group.tokens, 0)}
                  />
                </ProfileSection>
              ) : null}
              <ProfileSection title="Prompts by hour">
                <HourArc hours={profile.hours} />
              </ProfileSection>
            </div>
          ) : null}

          <ProfileSection title="Weeks">
            <span className="text-xl leading-tight tabular-nums">
              {weeks.filter((week) => week.tokens > 0).length} active weeks
            </span>
            <div className="mt-3">
              <WeekCapsules weeks={weeks} />
            </div>
          </ProfileSection>

          <ProfileSection title="Tokens" detail={`Last ${CHART_WINDOW_DAYS} days`}>
            <span className="text-xl leading-tight tabular-nums">
              {formatCompact(windowTokens)} tokens
            </span>
            <div className="mt-6">
              <DailyAreaChart points={series} />
            </div>
          </ProfileSection>

          <ProfileSection
            title="Prompts"
            detail={`Active ${activeDayCount(series)} of ${CHART_WINDOW_DAYS} days`}
          >
            <span className="text-xl leading-tight tabular-nums">
              {formatCompact(windowPrompts)} prompts
            </span>
            <div className="mt-6">
              <DailyBarChart points={series} />
            </div>
          </ProfileSection>
        </div>
      </main>
      <SiteFooter width={CONTENT_WIDTH} />
    </div>
  );
}

// ── Identity ───────────────────────────────────────────────────────────

function JoinedLine({ profile }: { profile: PublicProfile }) {
  const joined = joinedAgo(profile.createdAt, profile.localToday);
  return joined ? <span className="text-xs text-muted-foreground">{joined}</span> : null;
}

/** How each platform's username reads next to its icon. */
function socialHandleLabel(platform: SocialLinkPlatform, username: string): string {
  return platform === "github" || platform === "linkedin" ? username : `@${username}`;
}

/**
 * The owner's published accounts in a fixed order, each linking to its canonical profile
 * URL built from the validated username. `compact` (phones) shows the icons alone.
 */
function SocialLinkList({
  links,
  compact = false,
}: {
  links: PublicProfile["socialLinks"];
  compact?: boolean;
}) {
  const usernames = sanitizeSocialLinks(links);
  const platforms = SOCIAL_LINK_PLATFORMS.filter((platform) => usernames[platform]);
  if (platforms.length === 0) return null;
  return (
    <ul className={`m-0 flex list-none p-0 ${compact ? "items-center gap-1" : "flex-col gap-2.5"}`}>
      {platforms.map((platform) => {
        const username = usernames[platform]!;
        const Glyph = SOCIAL_GLYPHS[platform];
        return (
          <li key={platform} className="min-w-0">
            <a
              href={socialProfileUrl(platform, username)}
              target="_blank"
              rel="me noopener noreferrer"
              aria-label={compact ? `${socialLinkLabel(platform)}: ${username}` : undefined}
              className={
                compact
                  ? "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--tile)] hover:text-foreground"
                  : "flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              <Glyph aria-hidden className="size-4 shrink-0" />
              {compact ? null : (
                <span className="truncate">{socialHandleLabel(platform, username)}</span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

function ActivitySection({ profile }: { profile: PublicProfile }) {
  const today = profile.localToday ?? new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const cells = buildCalendarYearCells(profile.heatmap, today);
  return (
    <ProfileSection
      title="Activity"
      detail={`${formatCompact(tokensInYear(profile.heatmap, year))} tokens in ${year}`}
    >
      <div
        className="-mx-5 -mt-8 overflow-x-auto overscroll-x-contain px-5 pt-8 sm:mx-0 sm:mt-0 sm:overflow-visible sm:px-0 sm:pt-0"
        role="group"
        aria-label="Activity calendar, scroll to see the full year"
        tabIndex={0}
      >
        <ProfileHeatmap cells={cells} today={today} className="min-w-[640px] sm:min-w-0" />
      </div>
      <div className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        <span>Less</span>
        {APP_HEATMAP_INTENSITY_CLASSES.map((className) => (
          <span key={className} aria-hidden className={`size-2.5 rounded-full ${className}`} />
        ))}
        <span>More</span>
      </div>
    </ProfileSection>
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

/** The three most used models side by side, ranked, each with its share of tokens. */
function TopModels({
  groups,
  lifetimeTokens,
}: {
  groups: readonly ModelUsageGroup[];
  lifetimeTokens: number;
}) {
  if (groups.length === 0) return null;
  const total = Math.max(1, lifetimeTokens);
  return (
    <ProfileSection title="Models">
      <ol className="m-0 grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-3 sm:gap-4">
        {groups.slice(0, 3).map((group, index) => (
          <li
            key={`${group.provider}/${group.model}`}
            className="flex min-w-0 items-start justify-between gap-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ProviderGlyph provider={group.provider} className="size-4" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[15px] leading-snug">{group.displayName}</span>
                <span className="truncate text-xs tabular-nums text-muted-foreground">
                  {Math.round((group.tokens / total) * 100)}% · {formatCompact(group.tokens)}
                </span>
              </div>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
          </li>
        ))}
      </ol>
    </ProfileSection>
  );
}

/** The ring's slices: the top models by name, everything after folded into one. */
function ringShares(groups: readonly ModelUsageGroup[]): ModelShare[] {
  const named: ModelShare[] = groups.slice(0, RING_MODELS).map((group) => ({
    key: `${group.provider}/${group.model}`,
    label: group.displayName,
    tokens: group.tokens,
  }));
  const restTokens = groups.slice(RING_MODELS).reduce((sum, group) => sum + group.tokens, 0);
  return restTokens > 0
    ? [...named, { key: "rest", label: "Other models", tokens: restTokens, rest: true }]
    : named;
}
