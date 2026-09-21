import type { MetadataRoute } from "next";
import { getStaticSitemapEntries } from "@/lib/siteRoutes";

export default function sitemap(): MetadataRoute.Sitemap {
  return getStaticSitemapEntries();
}
