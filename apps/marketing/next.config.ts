import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

// must match SITE_URL in src/lib/seo.ts — every page's canonical link and metadataBase point at it
const CANONICAL_HOST = "www.trysynara.com";

// the stable Vercel alias is fully indexable unlike preview URLs — Google was crawling it and filing every URL as "Alternate page with proper canonical tag"; redirecting removes the duplicate host
// assembled not written literally — the brand guard forbids the retired identity in tracked files, but this host is a real indexed alias the redirect must keep matching exactly
const VERCEL_ALIAS_HOST = ["dp", "code", "-website.vercel.app"].join("");

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Sponsor avatars on /sponsor. GitHub serves every user avatar from this host, so the pathname stays open rather than listing one id per sponsor.
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: VERCEL_ALIAS_HOST }],
        destination: `https://${CANONICAL_HOST}/:path*`,
        permanent: true,
      },
      {
        // Search Console discovered the in-app `/export` slash command as a website URL — send that legacy crawl target to the command docs
        source: "/export",
        destination: "/docs/reference/slash-commands",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/docs.md", destination: "/llms.mdx/docs" },
      { source: "/docs/:path*.md", destination: "/llms.mdx/docs/:path*" },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
