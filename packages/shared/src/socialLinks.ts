/** Dependency-free social username validation and canonical public URLs.
 * Shared by account writes and public profile rendering, including Workers. */
export const SOCIAL_LINK_PLATFORMS = ["x", "linkedin", "github", "threads", "youtube"] as const;
export type SocialLinkPlatform = (typeof SOCIAL_LINK_PLATFORMS)[number];
export type SocialLinks = Partial<Record<SocialLinkPlatform, string>>;

const platforms = {
  x: {
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    hosts: ["x.com", "twitter.com"],
    path: /^\/([^/]+)\/?$/,
    url: "https://x.com/",
    label: "X",
  },
  linkedin: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/,
    hosts: ["linkedin.com"],
    path: /^\/in\/([^/]+)\/?$/,
    url: "https://www.linkedin.com/in/",
    label: "LinkedIn",
  },
  github: {
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    hosts: ["github.com"],
    path: /^\/([^/]+)\/?$/,
    url: "https://github.com/",
    label: "GitHub",
  },
  threads: {
    pattern: /^[A-Za-z0-9._]{1,30}$/,
    hosts: ["threads.com", "threads.net"],
    path: /^\/@([^/]+)\/?$/,
    url: "https://www.threads.com/@",
    label: "Threads",
  },
  youtube: {
    pattern: /^[A-Za-z0-9._-]{3,30}$/,
    hosts: ["youtube.com"],
    path: /^\/@([^/]+)\/?$/,
    url: "https://www.youtube.com/@",
    label: "YouTube",
  },
};

/** Accept only a username or a profile path on the selected platform's host. */
export function normalizeSocialUsername(
  platform: SocialLinkPlatform,
  input: string,
): string | null {
  const config = platforms[platform];
  let username = input.trim().replace(/^@/, "");
  if (username.includes("/")) {
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(username) ? username : `https://${username}`,
      );
      const host = url.hostname.replace(/^(www\.|m\.)/, "");
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.port ||
        !config.hosts.includes(host)
      )
        return null;
      username = config.path.exec(url.pathname)?.[1] ?? "";
    } catch {
      return null;
    }
  }
  return config.pattern.test(username) ? username : null;
}

export function socialProfileUrl(platform: SocialLinkPlatform, username: string): string {
  return `${platforms[platform].url}${username}`;
}

export function socialLinkLabel(platform: SocialLinkPlatform): string {
  return platforms[platform].label;
}

/** Read paths accept stored usernames only, never normalize arbitrary DB links. */
export function sanitizeSocialLinks(value: unknown): SocialLinks {
  const links: SocialLinks = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return links;
  for (const platform of SOCIAL_LINK_PLATFORMS) {
    if (!Object.hasOwn(value, platform)) continue;
    const username = (value as Record<string, unknown>)[platform];
    if (typeof username === "string" && platforms[platform].pattern.test(username))
      links[platform] = username;
  }
  return links;
}
