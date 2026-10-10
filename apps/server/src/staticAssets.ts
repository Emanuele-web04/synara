// serving policy for the built web bundle: precompressed sidecar negotiation + cache headers; the server never compresses on the request path

export const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// non-hashed files (index.html, manifests) must revalidate so deploys take effect on next load
export const STATIC_REVALIDATE_CACHE_CONTROL = "no-cache";
// icon sets have stable names changing only on dep bumps and the UI requests thousands per session — bounded max-age keeps them out of per-load revalidation without an eternal-cache hazard
export const STATIC_ICON_CACHE_CONTROL = "public, max-age=86400";

const ICON_DIRECTORY_PREFIXES = ["central-icons-reversed/", "central-icons-fill/"];

// Vite writes content-hashed names under assets/; everything else keeps a stable name and must revalidate
export function staticCacheControl(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("assets/")) return STATIC_IMMUTABLE_CACHE_CONTROL;
  if (ICON_DIRECTORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return STATIC_ICON_CACHE_CONTROL;
  }
  return STATIC_REVALIDATE_CACHE_CONTROL;
}

export interface StaticEncodingCandidate {
  readonly encoding: "br" | "gzip";
  readonly sidecarExtension: ".br" | ".gz";
}

// server preference order — brotli beats gzip when both accepted
const STATIC_ENCODING_CANDIDATES: readonly StaticEncodingCandidate[] = [
  { encoding: "br", sidecarExtension: ".br" },
  { encoding: "gzip", sidecarExtension: ".gz" },
];

// qvalue is 0..1 with ≤3 decimals — anything outside isn't a valid weight so the entry is ignored rather than treated as acceptable
const QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

// RFC 9110 §5.6.6 permits no whitespace around `=`, so `q =0` isn't a q-parameter — loose treatment would serve the encoding the client refused
function parseQValue(rawParams: readonly string[]): number | null {
  for (const param of rawParams) {
    const normalized = param.trim().toLowerCase();
    const separator = normalized.indexOf("=");
    if (separator < 0) continue;
    const name = normalized.slice(0, separator);
    // only a q-parameter decides the weight; other parameters ignored
    if (name.trimEnd() !== "q") continue;
    const value = normalized.slice(separator + 1);
    // whitespace around `=` is malformed not absent — falling back to default would serve the very encoding the client wrote `q =0` to refuse
    if (name !== "q" || value !== value.trim()) return null;
    return QVALUE_PATTERN.test(value) ? Number.parseFloat(value) : null;
  }
  return 1;
}

export interface StaticEncodingPreference {
  /** null marks identity's rank position — a client weighting identity above a coding gets the uncompressed body rather than a sidecar it ranked lower */
  readonly candidates: readonly (StaticEncodingCandidate | null)[];
  readonly identityAcceptable: boolean;
}

/** missing header means only identity is reliably acceptable; explicit weights beat `*`, q=0 excludes, server preference breaks ties; nothing acceptable → 406 */
export function negotiateStaticEncodingPreference(
  acceptEncoding: string | undefined,
): StaticEncodingPreference {
  if (!acceptEncoding) return { candidates: [null], identityAcceptable: true };
  const explicit = new Map<string, number>();
  for (const rawEntry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = rawEntry.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const weight = parseQValue(rawParams);
    if (weight === null) continue;
    // first occurrence wins — a repeated name is a malformed header
    if (!explicit.has(name)) explicit.set(name, weight);
  }
  const wildcard = explicit.get("*");
  // identity is acceptable by default (§12.5.3) unless a weight excludes it
  const identityWeight = explicit.get("identity") ?? wildcard ?? 1;
  const ranked: {
    readonly candidate: StaticEncodingCandidate | null;
    readonly weight: number;
    readonly preference: number;
  }[] = [
    ...STATIC_ENCODING_CANDIDATES.map((candidate, index) => ({
      candidate: candidate as StaticEncodingCandidate | null,
      weight: explicit.get(candidate.encoding) ?? wildcard ?? 0,
      preference: index,
    })),
    // identity ranks last among equals — a client weighting it the same as a coding still gets the smaller body
    { candidate: null, weight: identityWeight, preference: STATIC_ENCODING_CANDIDATES.length },
  ];

  return {
    candidates: ranked
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.preference - b.preference)
      .map((entry) => entry.candidate),
    identityAcceptable: identityWeight > 0,
  };
}

// sidecars are a negotiation detail never addressable resources — a direct request would serve compressed bytes with identity encoding and a misleading MIME; case-insensitive since macOS resolves app.js.BR to the real sidecar
export function isSidecarRequestPath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return lowered.endsWith(".br") || lowered.endsWith(".gz");
}

// weak comparison: the W/ prefix is ignored on both sides — a client storing the strong form still gets its 304
function opaqueTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

export function ifNoneMatchSatisfies(headerValue: string | undefined, etag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  const target = opaqueTag(etag);
  return trimmed.split(",").some((candidate) => opaqueTag(candidate) === target);
}

// weak validator derived from the served file's identity — computed from the sidecar when served since a Vary-keyed shared cache requires validators to differ per encoding
export function staticEtag(size: number, mtimeMs: number, encoding?: string): string {
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}${encoding ? `-${encoding}` : ""}"`;
}
