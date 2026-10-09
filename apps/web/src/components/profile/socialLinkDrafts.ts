// The Edit profile dialog's social-link fields: raw text per platform in, validated
// usernames out. A pasted profile link counts; anything else that doesn't parse is
// reported back so the dialog can mark that field.

import type { AccountProfileSocialLinks } from "@synara/contracts";
import {
  normalizeSocialUsername,
  SOCIAL_LINK_PLATFORMS,
  type SocialLinkPlatform,
  type SocialLinks,
} from "@synara/shared/socialLinks";

/** Field text per platform, seeded from the stored usernames. */
export function seedSocialLinkDrafts(
  links: AccountProfileSocialLinks | null | undefined,
): Record<SocialLinkPlatform, string> {
  return Object.fromEntries(
    SOCIAL_LINK_PLATFORMS.map((platform) => [platform, links?.[platform] ?? ""]),
  ) as Record<SocialLinkPlatform, string>;
}

/** Usernames from the field text (a pasted profile link counts), and the fields that don't parse. */
export function parseSocialLinkDrafts(drafts: Record<SocialLinkPlatform, string>): {
  usernames: SocialLinks;
  invalid: SocialLinkPlatform[];
} {
  const usernames: SocialLinks = {};
  const invalid: SocialLinkPlatform[] = [];
  for (const platform of SOCIAL_LINK_PLATFORMS) {
    const text = drafts[platform].trim();
    if (text.length === 0) continue;
    const username = normalizeSocialUsername(platform, text);
    if (username === null) {
      invalid.push(platform);
    } else {
      usernames[platform] = username;
    }
  }
  return { usernames, invalid };
}
