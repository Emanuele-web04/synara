import type { MetadataRoute } from "next";
import { getChangelogSitemapEntries } from "@/lib/siteRoutes";

export default function sitemap(): MetadataRoute.Sitemap {
  return getChangelogSitemapEntries();
}
