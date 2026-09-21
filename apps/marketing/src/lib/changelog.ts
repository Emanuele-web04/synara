import { CHANGELOG_ENTRIES, type ChangelogEntry } from "@/data/changelog";

// anchor shared by page sections and the rail nav so the two can't drift
export const toAnchor = (version: string) => `v${version.replace(/\./g, "-")}`;

export const toVersionSlug = (version: string) => `v${version}`;

export const fromVersionSlug = (slug: string) => (slug.startsWith("v") ? slug.slice(1) : slug);

export function getSortedReleases(): ChangelogEntry[] {
  return [...CHANGELOG_ENTRIES];
}

export function findRelease(version: string): ChangelogEntry | undefined {
  return CHANGELOG_ENTRIES.find((entry) => entry.version === version);
}
