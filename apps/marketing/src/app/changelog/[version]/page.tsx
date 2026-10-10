import { notFound } from "next/navigation";
import ChangelogContent from "@/components/ChangelogContent";
import { breadcrumbJsonLd, jsonLdScript, pageMetadata, releaseJsonLd } from "@/lib/seo";
import { findRelease, fromVersionSlug, getSortedReleases, toVersionSlug } from "@/lib/changelog";

export function generateStaticParams() {
  return getSortedReleases().map((entry) => ({
    version: toVersionSlug(entry.version),
  }));
}

// Only the versions we generate are valid; anything else 404s.
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ version: string }> }) {
  const { version: slug } = await params;
  const entry = findRelease(fromVersionSlug(slug));
  if (!entry) return {};

  const highlights = entry.features.map((f) => f.title).join(", ");
  return pageMetadata({
    title: `Synara ${entry.version} — Changelog`,
    description: `What's new in Synara ${entry.version} (${entry.date}): ${highlights}.`,
    path: `/changelog/${toVersionSlug(entry.version)}`,
  });
}

export default async function ChangelogVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version: slug } = await params;
  const entry = findRelease(fromVersionSlug(slug));
  if (!entry) notFound();

  const jsonLd = [
    releaseJsonLd(entry),
    breadcrumbJsonLd([
      { name: "Synara", path: "/" },
      { name: "Changelog", path: "/changelog" },
      {
        name: `Synara ${entry.version}`,
        path: `/changelog/${toVersionSlug(entry.version)}`,
      },
    ]),
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <ChangelogContent
        releases={[entry]}
        title={`Synara ${entry.version} release notes.`}
        description={`What changed in Synara ${entry.version} (${entry.date}), including ${entry.features
          .map((feature) => feature.title)
          .join(", ")}.`}
      />
    </>
  );
}
