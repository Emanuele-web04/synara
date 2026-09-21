// the wall splits at $49 where published perks start promising visible recognition — the only contribution info the site knows; amounts are never stored so they can't leak

import { SPONSORS, type Sponsor } from "@/data/sponsors";
import { GITHUB_SPONSORS_URL } from "@/lib/seo";

export type SponsorGroup = {
  id: string;
  title: string;
  sponsors: Sponsor[];
};

// the one recognition rule: top donors first, declaration order kept within each half — the wall and preview strip both derive from this so order can't diverge
function partitionByRecognition(sponsors: readonly Sponsor[]) {
  return {
    top: sponsors.filter((sponsor) => sponsor.top),
    rest: sponsors.filter((sponsor) => !sponsor.top),
  };
}

export function orderedSponsors(sponsors: readonly Sponsor[] = SPONSORS): Sponsor[] {
  const { top, rest } = partitionByRecognition(sponsors);
  return [...top, ...rest];
}

export function monthlyTierCheckoutUrl(amount: number) {
  return `${GITHUB_SPONSORS_URL}?frequency=recurring&amount=${amount}`;
}

/** GitHub has no fixed one-time tiers — this opens the custom-amount form. */
export const ONE_TIME_CHECKOUT_URL = `${GITHUB_SPONSORS_URL}?frequency=one-time`;

// the quiet second line drops the handle when it restates the name and collapses to null entirely — never render an empty row for uniform height
export function sponsorMetaLabel(sponsor: Sponsor) {
  const parts: string[] = [];
  if (sponsor.name.trim().toLowerCase() !== sponsor.login.trim().toLowerCase()) {
    parts.push(`@${sponsor.login}`);
  }
  if (sponsor.since) {
    parts.push(`since ${sponsor.since}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function sponsorLink(sponsor: Sponsor) {
  return sponsor.websiteUrl ?? `https://github.com/${sponsor.login}`;
}

/**
 * The same split as `orderedSponsors`, but kept as labelled groups for the
 * wall's headings. Empty groups are dropped so the page never shows a bare
 * heading.
 */
export function groupSponsors(sponsors: readonly Sponsor[] = SPONSORS): SponsorGroup[] {
  const { top, rest } = partitionByRecognition(sponsors);

  const groups: SponsorGroup[] = [
    { id: "top-donors", title: "Top donors", sponsors: top },
    { id: "donors", title: "Donors", sponsors: rest },
  ];

  return groups.filter((group) => group.sponsors.length > 0);
}
