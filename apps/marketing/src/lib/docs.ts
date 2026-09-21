import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export interface DocumentationCatalogEntry {
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly lastModified: Date | string | null;
}

const FALLBACK_DOCUMENTATION_DESCRIPTION = "Synara product documentation.";

// derived from Fumadocs so a second hand-maintained route list can't drift as guides are added
export function getDocumentationCatalog(): DocumentationCatalogEntry[] {
  return docsSource
    .getPages()
    .map((page) => ({
      title: page.data.title,
      description: page.data.description ?? FALLBACK_DOCUMENTATION_DESCRIPTION,
      url: page.url,
      lastModified: page.data.lastModified ?? null,
    }))
    .sort((left, right) => left.url.localeCompare(right.url));
}
