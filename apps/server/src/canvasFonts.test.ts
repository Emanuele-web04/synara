import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CanvasAssetUpload } from "@synara/contracts";
import { OutboundHttpError, type OutboundHttpRequest } from "@synara/shared/outboundHttp";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeCanvasFontService, type CanvasFontHttp } from "./canvasFonts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function tempDir() {
  const directory = await mkdtemp(path.join(tmpdir(), "synara-fonts-"));
  directories.push(directory);
  return directory;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CSS_ORIGIN = "https://fonts.googleapis.com";
const FILE_ORIGIN = "https://fonts.gstatic.com";
const HUNDREDS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const RANGES = {
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  "latin-ext": "U+0100-02BA, U+02BD-02C5, U+1E00-1E9F, U+A720-A7FF",
  latin: "U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+FEFF, U+FFFD",
  japanese: "U+3000-303F, U+4E00-4E3F",
};

function metadataFamily(
  family: string,
  fonts: string[],
  options: { popularity: number; category?: string; wght?: [number, number]; subsets?: string[] },
) {
  return {
    family,
    category: options.category ?? "Sans Serif",
    popularity: options.popularity,
    fonts: Object.fromEntries(fonts.map((key) => [key, { thickness: 5 }])),
    axes: options.wght ? [{ tag: "wght", min: options.wght[0], max: options.wght[1] }] : [],
    subsets: options.subsets ?? ["menu", "latin", "latin-ext"],
  };
}
const withItalics = (weights: number[]) => weights.flatMap((w) => [`${w}`, `${w}i`]);
const METADATA = {
  axisRegistry: [],
  familyMetadataList: [
    metadataFamily("Lato", withItalics([100, 300, 400, 700, 900]), { popularity: 9 }),
    metadataFamily("Inter", withItalics(HUNDREDS), { popularity: 5, wght: [100, 900] }),
    metadataFamily("Cardo", ["400", "400i", "700"], { popularity: 300, category: "Serif" }),
    metadataFamily("Sofia Sans Extra Condensed", ["1", ...HUNDREDS.map(String), "1000"], {
      popularity: 50,
      wght: [1, 1000],
    }),
    metadataFamily("Noto Sans Arabic", ["400"], { popularity: 1, subsets: ["menu", "arabic"] }),
    metadataFamily("Playfair Display", ["400", "700"], { popularity: 23, category: "Serif" }),
  ],
};

type Block = { subset: keyof typeof RANGES; style: string; weight: string; label?: string | null };
/** A css2 stylesheet shaped like Google's: a subset comment before each @font-face. */
function stylesheet(family: string, blocks: Block[]) {
  return blocks
    .map(({ subset, style, weight, label = subset }) =>
      [
        label === null ? "" : `/* ${label} */\n`,
        "@font-face {\n",
        `  font-family: '${family}';\n`,
        `  font-style: ${style};\n`,
        `  font-weight: ${weight};\n`,
        "  font-display: swap;\n",
        `  src: url(${FILE_ORIGIN}/s/${family.replaceAll(" ", "").toLowerCase()}/v1/${subset}-${style}-${weight.replace(" ", "-")}.woff2) format('woff2');\n`,
        `  unicode-range: ${RANGES[subset]};\n`,
        "}\n",
      ].join(""),
    )
    .join("");
}
const subsets = (
  style: string,
  weight: string,
  names: Block["subset"][],
  unlabeled = false,
): Block[] =>
  names.map((subset) =>
    unlabeled ? { subset, style, weight, label: null } : { subset, style, weight },
  );
const STYLESHEETS: Record<string, string> = {
  Inter: stylesheet("Inter", [
    ...subsets("italic", "100 900", ["cyrillic", "latin-ext", "latin"]),
    ...subsets("normal", "100 900", ["cyrillic", "latin-ext", "latin"]),
    { subset: "japanese", style: "normal", weight: "100 900", label: "[0]" },
  ]),
  "Sofia Sans Extra Condensed": stylesheet(
    "Sofia Sans Extra Condensed",
    subsets("normal", "100 900", ["latin-ext", "latin"]),
  ),
  // Unlabeled blocks: the unicode-range decides the subset.
  Cardo: stylesheet("Cardo", [
    ...subsets("normal", "400", ["cyrillic", "latin-ext", "latin"], true),
    ...subsets("normal", "700", ["latin"], true),
    ...subsets("italic", "400", ["latin"], true),
  ]),
  "Playfair Display": stylesheet("Playfair Display", [
    ...subsets("normal", "400", ["latin"]),
    ...subsets("normal", "700", ["latin"]),
  ]),
};

function woff2(size = 64) {
  const bytes = Buffer.alloc(size);
  bytes.write("wOF2", 0, "ascii");
  bytes.writeUInt32BE(size, 8);
  bytes.writeUInt32BE(size * 2, 16);
  return bytes;
}

type Reply = { status?: number; body: string | Uint8Array } | Error;
function googleFonts(overrides: { metadata?: string; file?: () => Reply; css?: () => Reply } = {}) {
  return (url: URL): Reply => {
    if (url.origin === "https://fonts.google.com") {
      return { body: overrides.metadata ?? JSON.stringify(METADATA) };
    }
    if (url.origin === CSS_ORIGIN) {
      const family = url.searchParams.get("family")!.split(":")[0]!;
      return overrides.css?.() ?? { body: STYLESHEETS[family]! };
    }
    return overrides.file?.() ?? { body: woff2() };
  };
}
const offline = () => new OutboundHttpError("dns", "Outbound destination DNS lookup failed.");

function fakeHttp(respond: (url: URL) => Reply) {
  const requests: OutboundHttpRequest[] = [];
  const http: CanvasFontHttp = {
    async request(input) {
      const url = new URL(input.url);
      expect(input.policy.allowedOrigins).toEqual([url.origin]);
      requests.push(input);
      const reply = respond(url);
      if (reply instanceof Error) throw reply;
      const body =
        typeof reply.body === "string" ? new TextEncoder().encode(reply.body) : reply.body;
      return { status: reply.status ?? 200, headers: new Headers(), body, url: url.href };
    },
  };
  const urls = (origin: string) =>
    requests.map((request) => String(request.url)).filter((url) => url.startsWith(origin));
  return { http, requests, urls };
}

it("maps Google's metadata by popularity and caches it for a week", async () => {
  const stateDir = await tempDir();
  const google = fakeHttp(googleFonts({ metadata: `)]}'\n${JSON.stringify(METADATA)}` }));
  const catalog = await makeCanvasFontService({ stateDir, http: google.http }).catalog();

  expect(catalog.available).toBe(true);
  // Most popular first; the family without Latin files is left out.
  expect(catalog.families.map((font) => font.family)).toEqual([
    "Inter",
    "Lato",
    "Playfair Display",
    "Sofia Sans Extra Condensed",
    "Cardo",
  ]);
  expect(catalog.families).toContainEqual({
    family: "Inter",
    category: "Sans Serif",
    weights: HUNDREDS,
    italic: true,
    variable: true,
  });
  // CSS weights stop at 100..900, so wider axes are clamped.
  expect(catalog.families).toContainEqual({
    family: "Sofia Sans Extra Condensed",
    category: "Sans Serif",
    weights: HUNDREDS,
    italic: false,
    variable: true,
  });
  expect(catalog.families).toContainEqual({
    family: "Cardo",
    category: "Serif",
    weights: [400, 700],
    italic: true,
    variable: false,
  });

  const disconnected = fakeHttp(offline);
  const cached = makeCanvasFontService({ stateDir, http: disconnected.http });
  expect(await cached.catalog()).toEqual(catalog);
  expect(disconnected.requests).toHaveLength(0);
});

it("serves a stale catalog offline, refreshes it online, and reports none without a cache", async () => {
  const stateDir = await tempDir();
  await makeCanvasFontService({ stateDir, http: fakeHttp(googleFonts()).http }).catalog();
  const catalogPath = path.join(stateDir, "design-canvases", "fonts", "catalog.json");
  const file = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, unknown>;
  await writeFile(catalogPath, JSON.stringify({ ...file, fetchedAt: Date.now() - 8 * DAY_MS }));

  const disconnected = fakeHttp(offline);
  const stale = makeCanvasFontService({ stateDir, http: disconnected.http });
  const staleCatalog = await stale.catalog();
  expect(staleCatalog.available).toBe(true);
  expect(staleCatalog.families).toHaveLength(5);
  await stale.catalog();
  // A failed refresh backs off instead of retrying on every call.
  expect(disconnected.requests).toHaveLength(1);

  const onlyLato = JSON.stringify({ familyMetadataList: [METADATA.familyMetadataList[0]] });
  const online = makeCanvasFontService({
    stateDir,
    http: fakeHttp(googleFonts({ metadata: onlyLato })).http,
  });
  expect((await online.catalog()).families.map((font) => font.family)).toEqual(["Lato"]);

  const empty = makeCanvasFontService({ stateDir: await tempDir(), http: fakeHttp(offline).http });
  expect(await empty.catalog()).toEqual({ families: [], available: false });
  await expect(empty.download("Inter")).rejects.toThrow("isn't available offline");
});

it("installs a variable family's Latin faces as valid work assets", async () => {
  const google = fakeHttp(googleFonts());
  const service = makeCanvasFontService({ stateDir: await tempDir(), http: google.http });
  const assets = await service.download("inter");

  const cssRequest = google.requests.find((request) => String(request.url).startsWith(CSS_ORIGIN));
  expect(String(cssRequest!.url)).toBe(
    `${CSS_ORIGIN}/css2?family=Inter:ital,wght@0,100..900;1,100..900&display=swap`,
  );
  expect(new Headers(cssRequest!.headers).get("user-agent")).toMatch(/Chrome\/\d+/);
  expect(assets.map((asset) => asset.id)).toEqual([
    "font_inter_100-900_italic_latin-ext",
    "font_inter_100-900_italic_latin",
    "font_inter_100-900_normal_latin-ext",
    "font_inter_100-900_normal_latin",
  ]);
  // Cyrillic and CJK slices are never fetched.
  expect(google.urls(FILE_ORIGIN)).toHaveLength(4);
  for (const asset of assets)
    expect(Schema.decodeUnknownSync(CanvasAssetUpload)(asset)).toEqual(asset);
  expect(assets[3]).toMatchObject({
    name: "Inter",
    mimeType: "font/woff2",
    sizeBytes: 64,
    font: { family: "Inter", weight: "100 900", style: "normal", unicodeRange: RANGES.latin },
  });
  expect(Buffer.from(assets[3]!.data, "base64").equals(woff2())).toBe(true);

  const sofia = await service.download("Sofia Sans Extra Condensed");
  expect(google.urls(CSS_ORIGIN)[1]).toBe(
    `${CSS_ORIGIN}/css2?family=Sofia+Sans+Extra+Condensed:wght@100..900&display=swap`,
  );
  expect(sofia.map((asset) => asset.id)).toEqual([
    "font_sofia-sans-extra-condensed_100-900_normal_latin-ext",
    "font_sofia-sans-extra-condensed_100-900_normal_latin",
  ]);
  for (const asset of sofia)
    expect(Schema.decodeUnknownSync(CanvasAssetUpload)(asset)).toEqual(asset);
});

it("requests each listed weight of a static family", async () => {
  const google = fakeHttp(googleFonts());
  const service = makeCanvasFontService({ stateDir: await tempDir(), http: google.http });

  const cardo = await service.download("  Cardo ");
  expect(google.urls(CSS_ORIGIN)[0]).toBe(
    `${CSS_ORIGIN}/css2?family=Cardo:ital,wght@0,400;0,700;1,400&display=swap`,
  );
  expect(cardo.map((asset) => [asset.id, asset.font?.weight, asset.font?.style])).toEqual([
    ["font_cardo_400_normal_latin-ext", "400", "normal"],
    ["font_cardo_400_normal_latin", "400", "normal"],
    ["font_cardo_700_normal_latin", "700", "normal"],
    ["font_cardo_400_italic_latin", "400", "italic"],
  ]);

  await service.download("Playfair Display");
  expect(google.urls(CSS_ORIGIN)[1]).toBe(
    `${CSS_ORIGIN}/css2?family=Playfair+Display:wght@400;700&display=swap`,
  );
});

it("reuses downloaded files for later adds, even offline", async () => {
  const stateDir = await tempDir();
  const assets = await makeCanvasFontService({
    stateDir,
    http: fakeHttp(googleFonts()).http,
  }).download("Inter");

  const again = fakeHttp(googleFonts());
  expect(await makeCanvasFontService({ stateDir, http: again.http }).download("Inter")).toEqual(
    assets,
  );
  expect(again.urls(FILE_ORIGIN)).toHaveLength(0);

  const disconnected = makeCanvasFontService({ stateDir, http: fakeHttp(offline).http });
  expect(await disconnected.download("Inter")).toEqual(assets);
});

it("rejects files that are not WOFF2 and does not cache them", async () => {
  const stateDir = await tempDir();
  const html = { body: "<!doctype html><title>Not a font</title>".padEnd(96, " ") };
  const service = makeCanvasFontService({
    stateDir,
    http: fakeHttp(googleFonts({ file: () => html })).http,
  });
  await expect(service.download("Inter")).rejects.toThrow("not a valid WOFF2 font");

  const retry = fakeHttp(googleFonts());
  await makeCanvasFontService({ stateDir, http: retry.http }).download("Inter");
  expect(retry.urls(FILE_ORIGIN)).toHaveLength(4);
});

it("explains unknown families, oversized families, and network failures", async () => {
  const service = makeCanvasFontService({
    stateDir: await tempDir(),
    http: fakeHttp(googleFonts()).http,
  });
  await expect(service.download("Comic Sans")).rejects.toThrow(
    `"Comic Sans" isn't a Google Fonts family.`,
  );

  const oversized = makeCanvasFontService({
    stateDir: await tempDir(),
    http: fakeHttp(googleFonts({ file: () => ({ body: woff2(1_100_000) }) })).http,
  });
  await expect(oversized.download("Inter")).rejects.toThrow("more than 3 MiB");

  const unreachable = makeCanvasFontService({
    stateDir: await tempDir(),
    http: fakeHttp(googleFonts({ css: offline })).http,
  });
  await expect(unreachable.download("Inter")).rejects.toThrow(
    "Couldn't download Inter from Google Fonts. Check your connection and try again.",
  );
});
