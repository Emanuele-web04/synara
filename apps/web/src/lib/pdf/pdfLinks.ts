import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "./pdfEngine";

export interface PdfLink {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  targetPageNumber?: number;
}

interface RawLinkAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
}

// named dests repeat across pages — memoize per document (cache the in-flight promise so concurrent lookups share one round-trip); resolveDestinationToPage never rejects so caching unresolved names is safe
const namedDestPageCache = new WeakMap<
  PDFDocumentProxy,
  Map<string, Promise<number | undefined>>
>();

async function resolveDestinationToPage(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | undefined> {
  try {
    const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicitDest) || explicitDest.length === 0) {
      return undefined;
    }
    const ref = explicitDest[0];
    if (typeof ref === "number" && Number.isInteger(ref)) {
      const pageNumber = ref + 1;
      return pageNumber >= 1 && pageNumber <= doc.numPages ? pageNumber : undefined;
    }
    if (ref == null || typeof ref !== "object") {
      return undefined;
    }
    const pageIndex = await doc.getPageIndex(
      ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
    );
    return pageIndex + 1;
  } catch {
    return undefined;
  }
}

async function resolveInternalPageNumber(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | undefined> {
  if (typeof dest !== "string") {
    return resolveDestinationToPage(doc, dest);
  }
  let cache = namedDestPageCache.get(doc);
  if (!cache) {
    cache = new Map();
    namedDestPageCache.set(doc, cache);
  }
  const pending = cache.get(dest);
  if (pending) {
    return pending;
  }
  const resolution = resolveDestinationToPage(doc, dest);
  cache.set(dest, resolution);
  return resolution;
}

interface LinkCandidate {
  rect: number[];
  url: string | undefined;
  dest: unknown;
}

const SAFE_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function sanitizeAnnotationUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return SAFE_EXTERNAL_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export async function extractPageLinks(options: {
  doc: PDFDocumentProxy;
  page: PDFPageProxy;
  viewport: PageViewport;
}): Promise<PdfLink[]> {
  const annotations = (await options.page.getAnnotations({
    intent: "display",
  })) as RawLinkAnnotation[];

  const candidates: LinkCandidate[] = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link") {
      continue;
    }
    const rect = annotation.rect;
    if (!rect || rect.length < 4) {
      continue;
    }
    candidates.push({
      rect,
      // pdf.js exposes rejected protocols as unsafeUrl — ignore it and keep only sanitized schemes safe to hand to the OS
      url: sanitizeAnnotationUrl(annotation.url),
      dest: annotation.dest,
    });
  }

  const targetPageNumbers = await Promise.all(
    candidates.map((candidate) =>
      !candidate.url && candidate.dest != null
        ? resolveInternalPageNumber(options.doc, candidate.dest)
        : Promise.resolve<number | undefined>(undefined),
    ),
  );

  // Assemble in original order, dropping inert links (no URL, no resolvable page). `index` numbers only the kept links, matching the prior id scheme.
  const links: PdfLink[] = [];
  let index = 0;
  for (const [position, candidate] of candidates.entries()) {
    const targetPageNumber = targetPageNumbers[position];
    if (!candidate.url && targetPageNumber == null) {
      continue;
    }
    const [x1, y1, x2, y2] = options.viewport.convertToViewportRectangle(candidate.rect) as [
      number,
      number,
      number,
      number,
    ];
    links.push({
      id: `${options.page.pageNumber}:${index}`,
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      ...(candidate.url ? { url: candidate.url } : {}),
      ...(targetPageNumber != null ? { targetPageNumber } : {}),
    });
    index += 1;
  }
  return links;
}
