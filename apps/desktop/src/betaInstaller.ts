// FILE: betaInstaller.ts
// Purpose: Download, verify, and install Synara Beta on macOS from a
//          generic update feed (beta-mac.yml + the zip it lists).
// Layer: Desktop platform adapter (no Electron imports; I/O is injectable for tests).
//
// Feed resolution: `SYNARA_BETA_FEED_URL` points at a base URL that serves
// `beta-mac.yml` plus the files it lists. Without it, the newest GitHub
// `v*-beta.N` release on Emanuele-web04/synara provides the manifest.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { BETA_RELEASE_TAG_PATTERN, SYNARA_BETA_RELEASES_API_URL } from "@synara/shared/betaChannel";
import { SYNARA_BETA_BUNDLE_ID } from "@synara/shared/desktopIdentity";

export const BETA_MAC_MANIFEST_NAME = "beta-mac.yml";
export const BETA_MAC_APP_NAME = "Synara Beta.app";

export interface BetaFeedFile {
  readonly url: string;
  readonly sha512: string;
  readonly size?: number;
}

export interface BetaMacManifest {
  readonly version: string;
  readonly files: readonly BetaFeedFile[];
}

export type BetaInstallPhase = "downloading" | "verifying" | "installing" | "opening";

export interface BetaInstallProgress {
  readonly phase: BetaInstallPhase;
  /** 0-100 while the download reports a content length; null when indeterminate. */
  readonly percent: number | null;
}

const unquoteYamlScalar = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

function assignFileField(
  file: { url?: string; sha512?: string; size?: number },
  key: string | undefined,
  rawValue: string | undefined,
): void {
  if (key === undefined || rawValue === undefined) return;
  const value = unquoteYamlScalar(rawValue);
  if (key === "url") file.url = value;
  else if (key === "sha512") file.sha512 = value;
  else if (key === "size") {
    const size = Number(value);
    if (Number.isFinite(size)) file.size = size;
  }
}

/**
 * Parses the electron-builder mac update manifest (`beta-mac.yml` /
 * `latest-mac.yml`). Only the two shapes electron-builder emits are handled:
 * top-level scalars and a `files:` list of `url`/`sha512`/`size` maps.
 */
export function parseBetaMacManifest(text: string): BetaMacManifest {
  let version: string | null = null;
  const files: BetaFeedFile[] = [];
  let current: { url?: string; sha512?: string; size?: number } | null = null;
  let inFiles = false;
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t") && !rawLine.startsWith("-")) {
      inFiles = false;
      current = null;
      const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      if (match[1] === "files") {
        inFiles = true;
        continue;
      }
      if (match[1] === "version" && match[2] !== undefined) {
        version = unquoteYamlScalar(match[2]);
      }
      continue;
    }
    if (!inFiles) continue;
    if (trimmed.startsWith("- ")) {
      current = {};
      files.push(current as BetaFeedFile);
      const pair = trimmed.slice(2).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (pair) assignFileField(current, pair[1], pair[2]);
      continue;
    }
    const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair && current) assignFileField(current, pair[1], pair[2]);
  }
  const valid = files.filter(
    (file) => typeof file.url === "string" && typeof file.sha512 === "string",
  );
  if (!version || valid.length === 0) {
    throw new Error(`Could not parse ${BETA_MAC_MANIFEST_NAME}: missing version or files.`);
  }
  return { version, files: valid };
}

/**
 * Picks the zip matching `arch` from the manifest files. A single zip without
 * an arch suffix is accepted so single-arch feeds still resolve.
 */
export function selectBetaDownloadFile(files: readonly BetaFeedFile[], arch: string): BetaFeedFile {
  const zips = files.filter((file) => file.url.endsWith(".zip"));
  const unmarked = zips.length === 1 ? zips[0] : undefined;
  const selected =
    zips.find((file) => file.url.includes(`-${arch}-`) || file.url.endsWith(`-${arch}.zip`)) ??
    (unmarked && !/-(arm64|x64)[-.]/.test(unmarked.url) ? unmarked : undefined);
  if (!selected) {
    throw new Error(`No beta download for ${arch} in ${BETA_MAC_MANIFEST_NAME}.`);
  }
  return selected;
}

export interface BetaFeedLocation {
  /** Absolute URL of the `beta-mac.yml` manifest. */
  readonly manifestUrl: string;
  /** Base URL that manifest file names resolve against. */
  readonly baseUrl: string;
}

export type FetchText = (url: string) => Promise<string>;

const FEED_IDLE_TIMEOUT_MS = 30_000;
const FEED_MAX_REDIRECTS = 5;

/**
 * HTTPS everywhere; plain HTTP is accepted only for loopback hosts so a local
 * demo feed can serve the manifest without a certificate.
 */
function feedGet(
  url: string,
  options: RequestOptions,
  onResponse: Parameters<typeof httpsGet>[2],
): ReturnType<typeof httpsGet> {
  const parsed = new URL(url);
  const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error(`Refusing plain-HTTP beta feed for non-loopback host ${parsed.hostname}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported beta feed protocol ${parsed.protocol}.`);
  }
  const request =
    parsed.protocol === "http:"
      ? (httpGet(url, options, onResponse) as ReturnType<typeof httpsGet>)
      : httpsGet(url, options, onResponse);
  // Idle timeout: a stalled connection fails the install instead of pinning it forever.
  request.setTimeout(FEED_IDLE_TIMEOUT_MS, () => {
    request.destroy(new Error(`Timed out downloading ${url}. Try again.`));
  });
  return request;
}

/** Default fetch over HTTPS, following at most 5 release-asset redirects. */
export const httpsFetchText: FetchText = (url) => fetchTextWithRedirects(url, 0);

const fetchTextWithRedirects = (url: string, redirects: number): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    let request;
    try {
      request = feedGet(url, { headers: { "user-agent": "synara-desktop" } }, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          response.resume();
          if (redirects >= FEED_MAX_REDIRECTS) {
            rejectPromise(new Error("Too many redirects"));
            return;
          }
          resolvePromise(fetchTextWithRedirects(new URL(location, url).toString(), redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectPromise(new Error(`GET ${url} failed with ${status}.`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
        response.on("error", rejectPromise);
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    request.on("error", rejectPromise);
  });

/**
 * Resolves where the beta update manifest lives. `feedUrlOverride` is a base
 * URL serving `beta-mac.yml` and the listed files; otherwise the newest GitHub
 * `v*-beta.N` release supplies it through its `beta-mac.yml` asset.
 */
export async function resolveBetaFeedLocation(input: {
  readonly feedUrlOverride?: string | undefined;
  readonly fetchText?: FetchText;
}): Promise<BetaFeedLocation> {
  const override = input.feedUrlOverride?.trim();
  if (override) {
    const base = override.endsWith("/") ? override : `${override}/`;
    return { manifestUrl: `${base}${BETA_MAC_MANIFEST_NAME}`, baseUrl: base };
  }
  const fetchText = input.fetchText ?? httpsFetchText;
  const releases = JSON.parse(await fetchText(SYNARA_BETA_RELEASES_API_URL)) as unknown;
  if (!Array.isArray(releases)) {
    throw new Error("Unexpected GitHub releases response.");
  }
  for (const release of releases as { tag_name?: unknown; assets?: unknown }[]) {
    if (typeof release.tag_name !== "string" || !BETA_RELEASE_TAG_PATTERN.test(release.tag_name)) {
      continue;
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifest = assets.find(
      (asset) => (asset as { name?: unknown }).name === BETA_MAC_MANIFEST_NAME,
    );
    const downloadUrl = (manifest as { browser_download_url?: unknown } | undefined)
      ?.browser_download_url;
    if (typeof downloadUrl === "string") {
      return {
        manifestUrl: downloadUrl,
        baseUrl: downloadUrl.slice(0, downloadUrl.lastIndexOf("/") + 1),
      };
    }
  }
  throw new Error("No beta release with a beta-mac.yml asset was found on GitHub.");
}

export function sha512FileBase64(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

export type DownloadFile = (
  url: string,
  destinationPath: string,
  onProgress: (percent: number | null) => void,
) => Promise<void>;

/** Streams a URL to disk, reporting percent when the server sends a length. */
export const httpsDownloadFile: DownloadFile = (url, destinationPath, onProgress) =>
  downloadFileWithRedirects(url, destinationPath, onProgress, 0);

const downloadFileWithRedirects = (
  url: string,
  destinationPath: string,
  onProgress: (percent: number | null) => void,
  redirects: number,
): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    let request;
    try {
      request = feedGet(url, { headers: { "user-agent": "synara-desktop" } }, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          response.resume();
          if (redirects >= FEED_MAX_REDIRECTS) {
            rejectPromise(new Error("Too many redirects"));
            return;
          }
          resolvePromise(
            downloadFileWithRedirects(
              new URL(location, url).toString(),
              destinationPath,
              onProgress,
              redirects + 1,
            ),
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectPromise(new Error(`GET ${url} failed with ${status}.`));
          return;
        }
        const total = Number(response.headers["content-length"] ?? 0);
        let received = 0;
        const out = createWriteStream(destinationPath);
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress(total > 0 ? Math.round((received / total) * 100) : null);
        });
        response.pipe(out);
        out.on("finish", () => resolvePromise());
        out.on("error", rejectPromise);
        response.on("error", rejectPromise);
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    request.on("error", rejectPromise);
  });

export type RunCommand = (command: string, args: readonly string[]) => void;

const execFile: RunCommand = (command, args) => {
  execFileSync(command, [...args], { stdio: "pipe" });
};

export type ReadCommand = (
  command: string,
  args: readonly string[],
) => { status: number; stdout: string; stderr: string };

const readCommandDefault: ReadCommand = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

const TEAM_ID_LINE_PATTERN = /^TeamIdentifier=(\S+)$/m;
const UNSIGNED_BETA_MESSAGE = "The beta download isn't signed by Synara. It wasn't installed.";
const TEAM_ID_LOOKUP_FAILED_MESSAGE =
  "Couldn't check the beta download's signature. Try the download page instead.";

/**
 * Team id the downloaded bundle must be signed by. `null` skips the check
 * (the running app is unsigned, e.g. a dev build); `"unavailable"` means the
 * running packaged app could not determine its own team id, which fails
 * closed rather than skipping verification.
 */
export type ExpectedTeamId = string | null | "unavailable";

/**
 * Gatekeeper never assesses downloads made by our own HTTPS client, and the
 * sha512 comes from the same release feed as the zip — so the signature is
 * checked against the team id of the app doing the installing. A null team id
 * means the running app is unsigned itself (local/demo builds) and there is
 * nothing to compare against, so the check is skipped.
 */
export function verifyBetaCodeSignature(
  appPath: string,
  expectedTeamId: ExpectedTeamId,
  readCommand: ReadCommand,
): void {
  if (expectedTeamId === null) return;
  if (expectedTeamId === "unavailable") throw new Error(TEAM_ID_LOOKUP_FAILED_MESSAGE);
  const verify = readCommand("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (verify.status !== 0) throw new Error(UNSIGNED_BETA_MESSAGE);
  const info = readCommand("codesign", ["-dv", "--verbose=4", appPath]);
  const teamId = TEAM_ID_LINE_PATTERN.exec(info.stderr)?.[1];
  if (teamId !== expectedTeamId) throw new Error(UNSIGNED_BETA_MESSAGE);
}

/**
 * The extracted bundle must be the beta flavor: a stray or renamed app in the
 * zip must fail the install instead of landing on disk.
 */
export function verifyBetaAppBundle(appPath: string): void {
  const plistPath = join(appPath, "Contents", "Info.plist");
  let plist: string;
  try {
    plist = readFileSync(plistPath, "utf8");
  } catch {
    throw new Error(`The download did not contain ${BETA_MAC_APP_NAME}.`);
  }
  const bundleId = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (bundleId !== SYNARA_BETA_BUNDLE_ID) {
    throw new Error(`Downloaded app is not Synara Beta (bundle id ${bundleId ?? "missing"}).`);
  }
}

export interface BetaInstallDeps {
  readonly arch: string;
  readonly installDir: string;
  readonly feedUrlOverride?: string | undefined;
  /** Team id the downloaded bundle must be signed by; null skips the check. */
  readonly expectedTeamId?: ExpectedTeamId;
  readonly fetchText?: FetchText;
  readonly downloadFile?: DownloadFile;
  readonly run?: RunCommand;
  readonly readCommand?: ReadCommand;
  readonly tempBaseDir?: string;
}

/**
 * Downloads the newest beta build, verifies its sha512 and bundle identity,
 * and moves `Synara Beta.app` into `installDir`. Throws on any mismatch; an
 * interrupted run leaves no partial app behind.
 */
export async function installBetaFromFeed(
  deps: BetaInstallDeps,
  onProgress: (progress: BetaInstallProgress) => void,
): Promise<string> {
  const fetchText = deps.fetchText ?? httpsFetchText;
  const downloadFile = deps.downloadFile ?? httpsDownloadFile;
  const run = deps.run ?? execFile;
  const workDir = mkdtempSync(join(deps.tempBaseDir ?? tmpdir(), "synara-beta-install-"));
  try {
    const location = await resolveBetaFeedLocation({
      feedUrlOverride: deps.feedUrlOverride,
      fetchText,
    });
    const manifest = parseBetaMacManifest(await fetchText(location.manifestUrl));
    const file = selectBetaDownloadFile(manifest.files, deps.arch);

    onProgress({ phase: "downloading", percent: 0 });
    const zipUrl = new URL(file.url, location.baseUrl).toString();
    const zipPath = join(workDir, basename(new URL(zipUrl).pathname));
    await downloadFile(zipUrl, zipPath, (percent) => onProgress({ phase: "downloading", percent }));

    onProgress({ phase: "verifying", percent: null });
    if (sha512FileBase64(zipPath) !== file.sha512) {
      throw new Error("The beta download failed its checksum. Try again.");
    }

    onProgress({ phase: "installing", percent: null });
    const extractDir = join(workDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    run("ditto", ["-x", "-k", zipPath, extractDir]);
    const appPath = join(extractDir, BETA_MAC_APP_NAME);
    // A symlinked bundle must never leave the temp dir: `mv` would write the
    // symlink target outside installDir or plant a link pointing elsewhere.
    const appStat = lstatSync(appPath, { throwIfNoEntry: false });
    if (appStat !== undefined && (!appStat.isDirectory() || appStat.isSymbolicLink())) {
      throw new Error(UNSIGNED_BETA_MESSAGE);
    }
    verifyBetaAppBundle(appPath);
    verifyBetaCodeSignature(
      appPath,
      deps.expectedTeamId ?? null,
      deps.readCommand ?? readCommandDefault,
    );
    mkdirSync(deps.installDir, { recursive: true });
    const targetPath = join(deps.installDir, BETA_MAC_APP_NAME);
    rmSync(targetPath, { recursive: true, force: true });
    run("mv", [appPath, targetPath]);
    return targetPath;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
