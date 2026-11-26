// FILE: canvasFonts.ts
// Purpose: Google Fonts catalog and download-once WOFF2 store for design canvas works.
//          Designs name a family (`font-family: Inter`); its Latin files become
//          work-owned assets, so frames render offline and identically everywhere.
// Layer: Server runtime utility (plain module with a promise API).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CanvasAssetUpload, CanvasFontCatalog, CanvasFontFamily } from "@synara/contracts";
import {
  OutboundHttpError,
  decodeOutboundText,
  outboundHttp,
  type OutboundHttpClient,
  type OutboundHttpPolicy,
  type OutboundHttpResponse,
} from "@synara/shared/outboundHttp";
import { Effect, Schema } from "effect";
import postcss, { type AtRule } from "postcss";
import { writeFileStringAtomically } from "./atomicWrite";

export type CanvasFontHttp = Pick<OutboundHttpClient, "request">;

const METADATA_ORIGIN = "https://fonts.google.com";
const CSS_ORIGIN = "https://fonts.googleapis.com";
const FILE_ORIGIN = "https://fonts.gstatic.com";
/** css2 serves WOFF2 only to browsers it recognizes; other agents get TTF. */
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed catalog fetch, serve what we have instead of retrying on every call. */
const CATALOG_RETRY_MS = 60 * 1000;
const MAX_CATALOG_FAMILIES = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FAMILY_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;
const SUBSETS = new Set(["latin", "latin-ext"]);
/** Becomes an asset name, so it must be a trimmed title of at most 120 characters. */
const FAMILY_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'&-]{0,118}[\p{L}\p{N}._'&-])?$/u;
const WEIGHT = /^\d{3}(?: \d{3})?$/;

const policy = (
  service: string,
  origin: string,
  timeoutMs: number,
  maxResponseBytes: number,
): OutboundHttpPolicy => ({
  service,
  allowedOrigins: [origin],
  timeoutMs,
  maxRequestBytes: 0,
  maxResponseBytes,
  maxRedirects: 2,
  maxConcurrent: DOWNLOAD_CONCURRENCY,
  maxQueued: 32,
  requirePublicAddress: true,
});
// The metadata is ~3 MB uncompressed (the client refuses compressed bodies).
const METADATA_POLICY = policy("canvas-fonts-metadata", METADATA_ORIGIN, 20_000, 16 * 1024 * 1024);
const CSS_POLICY = policy("canvas-fonts-css", CSS_ORIGIN, 15_000, 512 * 1024);
const FILE_POLICY = policy("canvas-fonts-files", FILE_ORIGIN, 30_000, MAX_FILE_BYTES);

const CatalogEntry = Schema.Struct({
  family: Schema.String,
  category: Schema.String,
  /** Inclusive `wght` axis range clamped to 100..900; null for static families. */
  axis: Schema.NullOr(Schema.Struct({ min: Schema.Int, max: Schema.Int })),
  /** Upright and italic weights; empty when the family has no such style. */
  upright: Schema.Array(Schema.Int),
  italic: Schema.Array(Schema.Int),
});
type CatalogEntry = typeof CatalogEntry.Type;
const CatalogFile = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAt: Schema.Finite,
  families: Schema.Array(CatalogEntry),
});

interface FontFace {
  readonly id: string;
  readonly weight: string;
  readonly style: "normal" | "italic";
  readonly unicodeRange?: string;
  readonly url: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const clampWeight = (weight: number) => Math.min(900, Math.max(100, weight));

/** Weights a metadata `fonts` map lists for one style ("400", "400i"); CSS only takes 100..900. */
function listedWeights(fonts: Record<string, unknown>, italic: boolean): number[] {
  const weights = new Set<number>();
  for (const key of Object.keys(fonts)) {
    const match = /^(\d{1,4})(i?)$/.exec(key);
    if (!match || (match[2] === "i") !== italic) continue;
    const weight = Number(match[1]);
    if (weight >= 100 && weight <= 900) weights.add(weight);
  }
  return [...weights].toSorted((a, b) => a - b);
}

function catalogEntry(raw: Record<string, unknown>): CatalogEntry | null {
  const { family, category, fonts, axes, subsets } = raw;
  if (typeof family !== "string" || !FAMILY_NAME.test(family) || !isRecord(fonts)) return null;
  // Only Latin files are installed, so a family without them would add nothing.
  if (!Array.isArray(subsets) || !subsets.includes("latin")) return null;
  const base = { family, category: typeof category === "string" ? category : "Other" };
  const upright = listedWeights(fonts, false);
  const italic = listedWeights(fonts, true);
  const wght = Array.isArray(axes)
    ? axes.find((axis) => isRecord(axis) && axis.tag === "wght")
    : null;
  if (isRecord(wght) && Number.isFinite(wght.min) && Number.isFinite(wght.max)) {
    const min = clampWeight(Math.ceil(wght.min as number));
    const max = clampWeight(Math.floor(wght.max as number));
    if (min < max) {
      // The axis ends plus every hundred between them, so pickers offer named steps.
      const weights = [
        min,
        ...[200, 300, 400, 500, 600, 700, 800].filter((w) => w > min && w < max),
        max,
      ];
      return {
        ...base,
        axis: { min, max },
        upright: upright.length > 0 || italic.length === 0 ? weights : [],
        italic: italic.length > 0 ? weights : [],
      };
    }
  }
  if (upright.length === 0 && italic.length === 0) return null;
  return { ...base, axis: null, upright, italic };
}

/** Maps Google's family metadata, most popular first. */
function parseMetadata(text: string): CatalogEntry[] {
  // Google guards some JSON endpoints with an XSSI prefix line.
  const json = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, "")) as unknown;
  const list = isRecord(json) ? json.familyMetadataList : null;
  if (!Array.isArray(list)) throw new Error("Google Fonts metadata has no family list.");
  const ranked: Array<{ entry: CatalogEntry; rank: number }> = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const entry = catalogEntry(raw);
    const rank = typeof raw.popularity === "number" ? raw.popularity : Number.POSITIVE_INFINITY;
    if (entry) ranked.push({ entry, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.entry.family.localeCompare(b.entry.family));
  const seen = new Set<string>();
  const entries = ranked
    .map(({ entry }) => entry)
    .filter((entry) => {
      const key = entry.family.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CATALOG_FAMILIES);
  if (entries.length === 0) throw new Error("Google Fonts metadata listed no usable families.");
  return entries;
}

const toFamily = (entry: CatalogEntry): CanvasFontFamily => ({
  family: entry.family,
  category: entry.category,
  weights: [...(entry.upright.length > 0 ? entry.upright : entry.italic)],
  italic: entry.italic.length > 0,
  variable: entry.axis !== null,
});

/** css2 request for every style the family has: an axis range, or each listed weight. */
function cssUrl(entry: CatalogEntry): string {
  const range = entry.axis ? `${entry.axis.min}..${entry.axis.max}` : null;
  const styleWeights = (weights: readonly number[]) =>
    weights.length === 0 ? [] : range ? [range] : weights.map(String);
  const upright = styleWeights(entry.upright);
  const italic = styleWeights(entry.italic);
  const axes =
    italic.length === 0
      ? `wght@${upright.join(";")}`
      : `ital,wght@${[...upright.map((w) => `0,${w}`), ...italic.map((w) => `1,${w}`)].join(";")}`;
  const name = encodeURIComponent(entry.family).replaceAll("%20", "+");
  return `${CSS_ORIGIN}/css2?family=${name}:${axes}&display=swap`;
}

/** Whether a CSS unicode-range (`U+0000-00FF, U+0131, U+4??`) includes a code point. */
function rangeIncludes(unicodeRange: string, codePoint: number): boolean {
  return unicodeRange.split(",").some((token) => {
    const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(token.trim());
    if (!match) return false;
    const start = parseInt(match[1]!.replaceAll("?", "0"), 16);
    const end = parseInt((match[2] ?? match[1]!).replaceAll("?", "F"), 16);
    return codePoint >= start && codePoint <= end;
  });
}

function fontSlug(family: string): string {
  const slug = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || sha256(family).slice(0, 12);
}

function fontFace(rule: AtRule, label: string, family: string): FontFace | null {
  const values = new Map<string, string>();
  rule.walkDecls((decl) => {
    values.set(decl.prop.toLowerCase(), decl.value.trim());
  });
  const unicodeRange = values.get("unicode-range");
  // Google labels each block (`/* latin */`); without a label, the range decides.
  const subset =
    label ||
    (unicodeRange === undefined
      ? "latin"
      : rangeIncludes(unicodeRange, 0x41)
        ? "latin"
        : rangeIncludes(unicodeRange, 0x100)
          ? "latin-ext"
          : "");
  if (!SUBSETS.has(subset)) return null;
  if (values.get("font-family")?.replace(/^(['"])(.*)\1$/, "$2") !== family) return null;
  const weight = (values.get("font-weight") ?? "400").replace(/\s+/g, " ");
  const style = values.get("font-style") ?? "normal";
  const url = /url\(\s*(['"]?)(https:\/\/[^'")\s]+)\1\s*\)\s*format\(\s*['"]?woff2['"]?\s*\)/i.exec(
    values.get("src") ?? "",
  )?.[2];
  if (!url || !URL.canParse(url) || new URL(url).origin !== FILE_ORIGIN) return null;
  if (!WEIGHT.test(weight) || (style !== "normal" && style !== "italic")) return null;
  if (unicodeRange !== undefined && unicodeRange.length > 2000) return null;
  return {
    id: `font_${fontSlug(family)}_${weight.replace(" ", "-")}_${style}_${subset}`,
    weight,
    style,
    url,
    ...(unicodeRange === undefined ? {} : { unicodeRange }),
  };
}

/** The Latin @font-face blocks of a css2 stylesheet, one per id. */
function parseFontFaces(css: string, family: string): FontFace[] {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch (cause) {
    throw new Error(`Google Fonts sent an unreadable stylesheet for ${family}.`, { cause });
  }
  const faces = new Map<string, FontFace>();
  let label = "";
  for (const node of root.nodes) {
    if (node.type === "comment") {
      label = node.text.trim().toLowerCase();
      continue;
    }
    if (node.type === "atrule" && node.name.toLowerCase() === "font-face") {
      const face = fontFace(node, label, family);
      if (face && !faces.has(face.id)) faces.set(face.id, face);
    }
    label = "";
  }
  return [...faces.values()];
}

/** WOFF2 header: magic, a declared length equal to the file, and a bounded decoded size. */
function isWoff2(bytes: Buffer): boolean {
  return (
    bytes.length >= 48 &&
    bytes.length <= MAX_FILE_BYTES &&
    bytes.toString("ascii", 0, 4) === "wOF2" &&
    bytes.readUInt32BE(8) === bytes.length &&
    bytes.readUInt32BE(16) <= 20_971_520
  );
}

/** Best effort: the cache only saves a refetch, so a failed write must not fail the add. */
const saveQuietly = (filePath: string, contents: string | Uint8Array) =>
  Effect.runPromise(writeFileStringAtomically({ filePath, contents })).catch(() => undefined);

export function makeCanvasFontService(input: { stateDir: string; http?: CanvasFontHttp }) {
  const http = input.http ?? outboundHttp;
  const directory = path.join(input.stateDir, "design-canvases", "fonts");
  const catalogPath = path.join(directory, "catalog.json");

  // undefined until the disk cache has been read once.
  let memory: { fetchedAt: number; entries: readonly CatalogEntry[] } | null | undefined;
  let retryAt = 0;
  let loading: Promise<readonly CatalogEntry[] | null> | null = null;
  const fresh = (fetchedAt: number) => {
    const age = Date.now() - fetchedAt;
    return age >= 0 && age < CATALOG_TTL_MS;
  };

  const readCatalogFile = async () => {
    try {
      const file = Schema.decodeUnknownSync(CatalogFile)(
        JSON.parse(await readFile(catalogPath, "utf8")),
      );
      return { fetchedAt: file.fetchedAt, entries: file.families };
    } catch {
      return null;
    }
  };

  /** Fresh cache, else the network, else whatever stale cache exists. Never throws. */
  const refreshCatalog = async (): Promise<readonly CatalogEntry[] | null> => {
    if (memory === undefined) memory = await readCatalogFile();
    if (memory && fresh(memory.fetchedAt)) return memory.entries;
    if (Date.now() < retryAt) return memory?.entries ?? null;
    try {
      const response = await http.request({
        policy: METADATA_POLICY,
        url: `${METADATA_ORIGIN}/metadata/fonts`,
        headers: { accept: "application/json" },
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const entries = parseMetadata(decodeOutboundText(response));
      memory = { fetchedAt: Date.now(), entries };
      await saveQuietly(
        catalogPath,
        JSON.stringify({ version: 1, fetchedAt: memory.fetchedAt, families: entries }),
      );
      return entries;
    } catch {
      retryAt = Date.now() + CATALOG_RETRY_MS;
      return memory?.entries ?? null;
    }
  };

  const loadCatalog = (): Promise<readonly CatalogEntry[] | null> => {
    if (memory && fresh(memory.fetchedAt)) return Promise.resolve(memory.entries);
    loading ??= refreshCatalog().finally(() => {
      loading = null;
    });
    return loading;
  };

  const get = async (
    requestPolicy: OutboundHttpPolicy,
    url: string,
    family: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OutboundHttpResponse> => {
    let response: OutboundHttpResponse;
    try {
      response = await http.request({
        policy: requestPolicy,
        url,
        headers,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof OutboundHttpError && cause.code === "response-too-large") {
        throw new Error(`A ${family} font file is larger than 2 MiB, so it can't be added.`, {
          cause,
        });
      }
      throw new Error(
        `Couldn't download ${family} from Google Fonts. Check your connection and try again.`,
        { cause },
      );
    }
    if (response.status !== 200) {
      throw new Error(`Google Fonts couldn't provide ${family} (HTTP ${response.status}).`);
    }
    return response;
  };

  /** A stylesheet that worked before still names cached files, so re-adding works offline. */
  const stylesheet = async (entry: CatalogEntry): Promise<string> => {
    const url = cssUrl(entry);
    const filePath = path.join(directory, "css", `${sha256(url)}.css`);
    try {
      const css = decodeOutboundText(
        await get(CSS_POLICY, url, entry.family, {
          accept: "text/css,*/*;q=0.1",
          "user-agent": CHROME_USER_AGENT,
        }),
      );
      await saveQuietly(filePath, css);
      return css;
    } catch (error) {
      const cached = await readFile(filePath, "utf8").catch(() => null);
      if (cached !== null) return cached;
      throw error;
    }
  };

  const fontFile = async (url: string, family: string, signal: AbortSignal): Promise<Buffer> => {
    const filePath = path.join(directory, "files", `${sha256(url)}.woff2`);
    const cached = await readFile(filePath).catch(() => null);
    if (cached && isWoff2(cached)) return cached;
    const response = await get(FILE_POLICY, url, family, { accept: "font/woff2" }, signal);
    const bytes = Buffer.from(
      response.body.buffer,
      response.body.byteOffset,
      response.body.byteLength,
    );
    if (!isWoff2(bytes)) {
      throw new Error(`Google Fonts sent a ${family} file that is not a valid WOFF2 font.`);
    }
    await saveQuietly(filePath, bytes);
    return bytes;
  };

  return {
    /** Families designs can install; `available: false` only when nothing could be loaded. */
    async catalog(): Promise<CanvasFontCatalog> {
      const entries = await loadCatalog();
      return entries
        ? { families: entries.map(toFamily), available: true }
        : { families: [], available: false };
    },

    /** The family's Latin WOFF2 files as work assets; throws a user-readable Error. */
    async download(family: string): Promise<CanvasAssetUpload[]> {
      const entries = await loadCatalog();
      if (!entries) {
        throw new Error(
          "The Google Fonts catalog isn't available offline. Connect to the internet and try again.",
        );
      }
      const wanted = family.trim().toLowerCase();
      const entry = entries.find((candidate) => candidate.family.toLowerCase() === wanted);
      if (!entry) {
        throw new Error(
          `"${family.trim()}" isn't a Google Fonts family. Pick one from the catalog.`,
        );
      }
      const faces = parseFontFaces(await stylesheet(entry), entry.family);
      if (faces.length === 0)
        throw new Error(`Google Fonts has no Latin files for ${entry.family}.`);

      let totalBytes = 0;
      const files = await Effect.runPromise(
        Effect.forEach(
          faces,
          (face) =>
            Effect.tryPromise({
              try: async (signal) => {
                const bytes = await fontFile(face.url, entry.family, signal);
                totalBytes += bytes.length;
                if (totalBytes > MAX_FAMILY_BYTES) {
                  throw new Error(
                    `${entry.family} needs more than 3 MiB of font files, which is too large to add to a work.`,
                  );
                }
                return bytes;
              },
              catch: (cause) => cause,
            }),
          { concurrency: DOWNLOAD_CONCURRENCY },
        ),
      );
      return faces.map((face, index) => {
        const bytes = files[index]!;
        return {
          id: face.id,
          name: entry.family,
          mimeType: "font/woff2",
          sizeBytes: bytes.length,
          data: bytes.toString("base64"),
          font: {
            family: entry.family,
            weight: face.weight,
            style: face.style,
            ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
          },
        };
      });
    },
  };
}
