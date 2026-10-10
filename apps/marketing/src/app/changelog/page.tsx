import ChangelogContent from "@/components/ChangelogContent";
import { breadcrumbJsonLd, changelogCollectionJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";
import { getSortedReleases } from "@/lib/changelog";

export const metadata = pageMetadata({
  title: "Changelog — Synara",
  description:
    "Every Synara release: new providers, performance work, and the steady polish that makes the app faster and sturdier. Updated with each version.",
  path: "/changelog",
});

export default function ChangelogPage() {
  const releases = getSortedReleases();
  const jsonLd = [
    changelogCollectionJsonLd(releases),
    breadcrumbJsonLd([
      { name: "Synara", path: "/" },
      { name: "Changelog", path: "/changelog" },
    ]),
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <ChangelogContent />
    </>
  );
}
