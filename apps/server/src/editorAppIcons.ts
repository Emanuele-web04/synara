// FILE: editorAppIcons.ts
// Purpose: Extract native installed-app icons for editor integrations and cache
//          the normalized image files on disk for cheap repeat HTTP requests.
// Layer: Server HTTP utility
// Exports: editor icon route constant plus cached icon resolver.
// Depends on: editor metadata, platform app discovery, filesystem, and OS icon tools.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { EDITORS, type EditorId } from "@synara/contracts";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";

import {
  getEditorMacApplications,
  getEditorWindowsStorePackages,
  resolveMacApplicationBundlePath,
  resolveWindowsStorePackageInstallLocation,
  type EditorDefinition,
} from "./editorAppDiscovery";

export { EDITOR_ICON_ROUTE_PATH };

const execFileAsync = promisify(execFile);
const MAX_DESKTOP_FILES_TO_SCAN = 1_500;
const MAX_ICON_FILES_TO_SCAN = 8_000;
const MAX_WINDOWS_PACKAGE_ICON_FILES_TO_SCAN = 1_200;
// Editors installed as CLI-only (no app bundle / desktop icon) never resolve a
// native icon. Cache that "structural" miss long enough to avoid re-running the
// subprocess + filesystem scans on every menu open, while still picking up a
// freshly installed editor within a few minutes.
const NEGATIVE_ICON_CACHE_TTL_MS = 300_000; // 5 min
// Editor rows render at ~14px. Cap the cached raster so a 512-1024px .icns is not
// served (and re-decoded) at full resolution on every menu open; 128px stays crisp
// on hi-dpi while shrinking payloads by one to two orders of magnitude.
const ICON_MAX_DIMENSION_PX = 128;

export interface CachedEditorIcon {
  readonly path: string;
  readonly contentType: string;
}

interface EditorIconSource {
  readonly sourcePath: string;
  readonly outputExtension: "png" | "svg";
  readonly contentType: string;
  readonly transform: "copy" | "sips-icns" | "windows-associated-icon";
}

const inFlight = new Map<string, Promise<CachedEditorIcon | null>>();
const negativeCache = new Map<string, number>();

function resolveEditor(editorId: string): EditorDefinition | null {
  return EDITORS.find((editor) => editor.id === editorId) ?? null;
}

function sanitizeCacheToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readPlistJson(infoPlistPath: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      infoPlistPath,
    ]);
    return JSON.parse(String(stdout)) as Record<string, unknown>;
  } catch {
    const xml = await fs.readFile(infoPlistPath, "utf8").catch(() => null);
    if (!xml) return null;
    return parseSimpleXmlPlist(xml);
  }
}

function parseSimpleXmlPlist(xml: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const pairPattern = /<key>([^<]+)<\/key>\s*<string>([^<]+)<\/string>/g;
  for (const match of xml.matchAll(pairPattern)) {
    if (match[1] && match[2]) {
      result[match[1]] = match[2];
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iconNamesFromInfoPlist(info: Record<string, unknown>): string[] {
  const names = [
    stringValue(info.CFBundleIconFile),
    stringValue(info.CFBundleIconName),
    ...stringArrayValue(
      readNestedRecord(
        readNestedRecord(readNestedRecord(info, "CFBundleIcons"), "CFBundlePrimaryIcon"),
        "CFBundleIconFiles",
      ),
    ),
  ];
  return Array.from(new Set(names.filter((name): name is string => name !== null)));
}

function iconFileCandidates(resourcesDir: string, iconName: string): string[] {
  if (path.extname(iconName)) return [path.join(resourcesDir, iconName)];
  return [
    path.join(resourcesDir, `${iconName}.icns`),
    path.join(resourcesDir, `${iconName}.png`),
    path.join(resourcesDir, `${iconName}.svg`),
  ];
}

async function findFirstIconInDirectory(dirPath: string): Promise<string | null> {
  const entries = await fs.readdir(dirPath).catch(() => []);
  const icon = entries.find((entry) => /\.(icns|png|svg)$/i.test(entry));
  return icon ? path.join(dirPath, icon) : null;
}

async function resolveMacEditorIconSource(input: {
  readonly editor: EditorDefinition;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<EditorIconSource | null> {
  const bundlePath = resolveMacApplicationBundlePath(
    getEditorMacApplications(input.editor),
    input.platform,
    input.env,
  );
  if (!bundlePath) return null;

  const resourcesDir = path.join(bundlePath, "Contents", "Resources");
  const info = await readPlistJson(path.join(bundlePath, "Contents", "Info.plist"));
  const iconNames = info ? iconNamesFromInfoPlist(info) : [];
  const candidates = iconNames.flatMap((iconName) => iconFileCandidates(resourcesDir, iconName));

  const fallbackIcon = await findFirstIconInDirectory(resourcesDir);
  if (fallbackIcon) candidates.push(fallbackIcon);

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    const extension = path.extname(candidate).toLowerCase();
    if (extension === ".icns") {
      return {
        sourcePath: candidate,
        outputExtension: "png",
        contentType: "image/png",
        transform: "sips-icns",
      };
    }
    if (extension === ".png") {
      return {
        sourcePath: candidate,
        outputExtension: "png",
        contentType: "image/png",
        transform: "copy",
      };
    }
    if (extension === ".svg") {
      return {
        sourcePath: candidate,
        outputExtension: "svg",
        contentType: "image/svg+xml",
        transform: "copy",
      };
    }
  }

  return null;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;
  return rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
}

async function resolveCommandPath(input: {
  readonly commands: readonly string[] | null;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (!input.commands) return null;
  const pathValue = resolvePathEnvironmentVariable(input.env);
  if (pathValue.length === 0) return null;
  const delimiter = input.platform === "win32" ? ";" : ":";
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
  const pathExtensions =
    input.platform === "win32" ? resolveWindowsPathExtensions(input.env) : [""];

  for (const command of input.commands) {
    const commandCandidates =
      input.platform === "win32" && !path.extname(command)
        ? pathExtensions.map((extension) => `${command}${extension}`)
        : [command];
    for (const pathEntry of pathEntries) {
      for (const commandCandidate of commandCandidates) {
        const candidate = path.join(pathEntry, commandCandidate);
        if (await fileExists(candidate)) return candidate;
      }
    }
  }
  return null;
}

function desktopSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dataDirs =
    env.XDG_DATA_DIRS !== undefined
      ? env.XDG_DATA_DIRS.split(":").filter(Boolean)
      : ["/usr/local/share", "/usr/share"];
  return [
    path.join(dataHome, "applications"),
    path.join(dataHome, "flatpak", "exports", "share", "applications"),
    ...dataDirs.map((dir) => path.join(dir, "applications")),
    "/var/lib/flatpak/exports/share/applications",
    "/snap",
  ];
}

function normalizeDesktopMatchValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function desktopIdentityTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(normalizeDesktopMatchValue)
    .filter(Boolean);
}

function parseDesktopEntryValues(content: string, key: string): string[] {
  const escapedKey = key.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}(?:\\[[^\\]]+\\])?\\s*=\\s*(.+?)\\s*$`, "gim");
  return Array.from(content.matchAll(pattern), (match) => match[1]?.trim() ?? "").filter(Boolean);
}

function editorIdentityCandidates(editor: EditorDefinition): string[] {
  return [editor.id, editor.label, ...(getEditorMacApplications(editor) ?? [])]
    .map(normalizeDesktopMatchValue)
    .filter(Boolean);
}

function editorCommandCandidates(editor: EditorDefinition): ReadonlySet<string> {
  return new Set(
    (editor.commands ?? [])
      .map((command) =>
        normalizeDesktopMatchValue(
          path.basename(command).replace(/\.(?:bat|cmd|com|exe|sh)$/i, ""),
        ),
      )
      .filter(Boolean),
  );
}

function identityValueMatchesCandidate(value: string, candidates: readonly string[]): boolean {
  const normalizedValue = normalizeDesktopMatchValue(value);
  const tokens = desktopIdentityTokens(value);
  return candidates.some((candidate) => {
    if (normalizedValue === candidate || tokens.includes(candidate)) return true;
    // Keep suffix/contains matching for long product names while avoiding short false positives.
    return (
      candidate.length >= 5 &&
      (normalizedValue.endsWith(candidate) || normalizedValue.includes(candidate))
    );
  });
}

function splitDesktopExecTokens(execValue: string): string[] {
  const withoutFieldCodes = execValue.replace(/%[a-zA-Z]/g, " ");
  const tokenPattern = /"([^"]+)"|'([^']+)'|(\S+)/g;
  return Array.from(
    withoutFieldCodes.matchAll(tokenPattern),
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  ).filter(Boolean);
}

function normalizeDesktopExecToken(token: string): string {
  return normalizeDesktopMatchValue(path.basename(token).replace(/\.(?:bat|cmd|com|exe|sh)$/i, ""));
}

function desktopFileMatchesEditor(
  content: string,
  desktopPath: string,
  editor: EditorDefinition,
): boolean {
  const identityCandidates = editorIdentityCandidates(editor);
  const identityValues = [
    path.basename(desktopPath, ".desktop"),
    ...parseDesktopEntryValues(content, "Name"),
    ...parseDesktopEntryValues(content, "StartupWMClass"),
  ];
  if (identityValues.some((value) => identityValueMatchesCandidate(value, identityCandidates))) {
    return true;
  }

  const commandCandidates = editorCommandCandidates(editor);
  return parseDesktopEntryValues(content, "Exec").some((execValue) =>
    splitDesktopExecTokens(execValue)
      .map(normalizeDesktopExecToken)
      .some((token) => commandCandidates.has(token)),
  );
}

async function findDesktopFile(
  editor: EditorDefinition,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  let scanned = 0;
  for (const dir of desktopSearchDirs(env)) {
    if (!(await directoryExists(dir))) continue;
    const pendingDirs = [dir];
    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir) continue;
      const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_DESKTOP_FILES_TO_SCAN) return null;
        const candidate = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          pendingDirs.push(candidate);
          continue;
        }
        if (!entry.name.endsWith(".desktop") || !(await fileExists(candidate))) continue;
        const content = await fs.readFile(candidate, "utf8").catch(() => null);
        if (content && desktopFileMatchesEditor(content, candidate, editor)) return candidate;
      }
    }
  }
  return null;
}

function parseDesktopIconName(content: string): string | null {
  const match = /^Icon=(.+)$/m.exec(content);
  return match?.[1]?.trim() || null;
}

function linuxIconSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dataDirs =
    env.XDG_DATA_DIRS !== undefined
      ? env.XDG_DATA_DIRS.split(":").filter(Boolean)
      : ["/usr/local/share", "/usr/share"];
  return [
    path.join(dataHome, "icons"),
    path.join(home, ".icons"),
    ...dataDirs.map((dir) => path.join(dir, "icons")),
    "/usr/share/pixmaps",
  ];
}

async function findIconByName(iconName: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (path.isAbsolute(iconName)) return (await fileExists(iconName)) ? iconName : null;

  const extensions = [".png", ".svg"];
  let scanned = 0;
  for (const dir of linuxIconSearchDirs(env)) {
    if (!(await directoryExists(dir))) continue;
    const pendingDirs = [dir];
    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir) continue;
      const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_ICON_FILES_TO_SCAN) return null;
        const candidate = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          pendingDirs.push(candidate);
          continue;
        }
        if (!extensions.some((extension) => entry.name === `${iconName}${extension}`)) continue;
        if (await fileExists(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function resolveLinuxEditorIconSource(input: {
  readonly editor: EditorDefinition;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<EditorIconSource | null> {
  if (input.platform !== "linux") return null;
  const desktopFile = await findDesktopFile(input.editor, input.env);
  if (!desktopFile) return null;
  const content = await fs.readFile(desktopFile, "utf8").catch(() => null);
  const iconName = content ? parseDesktopIconName(content) : null;
  if (!iconName) return null;
  const iconPath = await findIconByName(iconName, input.env);
  if (!iconPath) return null;
  const extension = path.extname(iconPath).toLowerCase();
  if (extension === ".svg") {
    return {
      sourcePath: iconPath,
      outputExtension: "svg",
      contentType: "image/svg+xml",
      transform: "copy",
    };
  }
  return {
    sourcePath: iconPath,
    outputExtension: "png",
    contentType: "image/png",
    transform: "copy",
  };
}

function scoreWindowsStoreIconPath(iconPath: string): number | null {
  const name = path.basename(iconPath).toLowerCase();
  const extension = path.extname(name);
  if (extension !== ".png" && extension !== ".svg") return null;

  let score = extension === ".png" ? 0 : 20;
  if (name.includes("square44x44logo")) {
    score += 0;
  } else if (name.includes("appicon") || name.includes("logo")) {
    score += 10;
  } else {
    score += 50;
  }

  if (name.includes("unplated")) score -= 3;
  if (name.includes("targetsize-256") || name.includes("scale-200")) score -= 2;
  if (name.includes("targetsize-48") || name.includes("scale-100")) score -= 1;
  return score;
}

async function findWindowsStorePackageIcon(packageDir: string): Promise<string | null> {
  const roots = Array.from(new Set([path.join(packageDir, "Assets"), packageDir]));
  let best: { path: string; score: number } | null = null;
  let scanned = 0;

  for (const root of roots) {
    if (!(await directoryExists(root))) continue;
    const pendingDirs = [root];
    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir) continue;
      const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_WINDOWS_PACKAGE_ICON_FILES_TO_SCAN) return best?.path ?? null;
        const candidate = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          pendingDirs.push(candidate);
          continue;
        }
        if (!(await fileExists(candidate))) continue;
        const score = scoreWindowsStoreIconPath(candidate);
        if (score === null) continue;
        if (!best || score < best.score) best = { path: candidate, score };
      }
    }
  }

  return best?.path ?? null;
}

async function resolveWindowsStoreEditorIconSource(input: {
  readonly editor: EditorDefinition;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<EditorIconSource | null> {
  const packages = getEditorWindowsStorePackages(input.editor);
  const findIconSource = async (packageDir: string): Promise<EditorIconSource | null> => {
    const iconPath = await findWindowsStorePackageIcon(packageDir);
    if (!iconPath) return null;
    const extension = path.extname(iconPath).toLowerCase();
    if (extension === ".svg") {
      return {
        sourcePath: iconPath,
        outputExtension: "svg",
        contentType: "image/svg+xml",
        transform: "copy",
      };
    }

    return {
      sourcePath: iconPath,
      outputExtension: "png",
      contentType: "image/png",
      transform: "copy",
    };
  };

  const appxPackageDir = resolveWindowsStorePackageInstallLocation(
    packages,
    input.platform,
    input.env,
  );
  if (appxPackageDir) return findIconSource(appxPackageDir);

  return null;
}

async function resolveWindowsEditorIconSource(input: {
  readonly editor: EditorDefinition;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<EditorIconSource | null> {
  if (input.platform !== "win32") return null;
  const storeSource = await resolveWindowsStoreEditorIconSource(input);
  if (storeSource) return storeSource;

  const exePath = await resolveCommandPath({
    commands: input.editor.commands ?? null,
    platform: input.platform,
    env: input.env,
  });
  if (!exePath) return null;
  return {
    sourcePath: exePath,
    outputExtension: "png",
    contentType: "image/png",
    transform: "windows-associated-icon",
  };
}

async function resolveEditorIconSource(input: {
  readonly editor: EditorDefinition;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}): Promise<EditorIconSource | null> {
  return (
    (await resolveMacEditorIconSource(input)) ??
    (await resolveLinuxEditorIconSource(input)) ??
    (await resolveWindowsEditorIconSource(input))
  );
}

async function cacheFileForSource(input: {
  readonly editorId: EditorId;
  readonly cacheDir: string;
  readonly source: EditorIconSource;
}): Promise<string> {
  const stat = await fs.stat(input.source.sourcePath);
  const hash = crypto
    .createHash("sha256")
    .update(input.editorId)
    .update("\0")
    .update(input.source.sourcePath)
    .update("\0")
    .update(String(stat.mtimeMs))
    .update("\0")
    .update(String(stat.size))
    .digest("hex")
    .slice(0, 16);
  return path.join(
    input.cacheDir,
    `${sanitizeCacheToken(input.editorId)}-${hash}.${input.source.outputExtension}`,
  );
}

async function materializeCachedIcon(input: {
  readonly source: EditorIconSource;
  readonly outputPath: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });

  // Build into a unique temp file, then atomically rename into place. This keeps
  // HTTP readers and concurrent resolvers (distinct env keys can map to the same
  // source/output) from ever observing a half-written icon file.
  const tempPath = `${input.outputPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeIconArtifact({ source: input.source, outputPath: tempPath });
    await fs.rename(tempPath, input.outputPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    // A concurrent resolver may have won the rename race (notably on Windows,
    // where renaming onto an existing file throws). If the output now exists,
    // the icon is materialized regardless of who wrote it.
    if (await fileExists(input.outputPath)) return;
    throw error;
  }
}

async function writeIconArtifact(input: {
  readonly source: EditorIconSource;
  readonly outputPath: string;
}): Promise<void> {
  if (input.source.transform === "copy") {
    await fs.copyFile(input.source.sourcePath, input.outputPath);
    return;
  }

  if (input.source.transform === "sips-icns") {
    // Convert .icns -> png and downscale to the display cap in a single pass.
    await execFileAsync("sips", [
      "-s",
      "format",
      "png",
      "-Z",
      String(ICON_MAX_DIMENSION_PX),
      input.source.sourcePath,
      "--out",
      input.outputPath,
    ]);
    return;
  }

  const escapedSource = input.source.sourcePath.replaceAll("'", "''");
  const escapedOutput = input.outputPath.replaceAll("'", "''");
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${escapedSource}')`,
    "if ($null -eq $icon) { exit 2 }",
    "$bitmap = $icon.ToBitmap()",
    `$bitmap.Save('${escapedOutput}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$bitmap.Dispose()",
    "$icon.Dispose()",
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
}

async function resolveCachedEditorIconUncached(input: {
  readonly editorId: string;
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CachedEditorIcon | null> {
  const editor = resolveEditor(input.editorId);
  if (!editor) return null;
  const source = await resolveEditorIconSource({
    editor,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
  });
  if (!source) return null;

  const outputPath = await cacheFileForSource({
    editorId: editor.id,
    cacheDir: input.cacheDir,
    source,
  });
  if (!(await fileExists(outputPath))) {
    await materializeCachedIcon({ source, outputPath });
  }
  return { path: outputPath, contentType: source.contentType };
}

function iconLookupCacheKey(input: {
  readonly editorId: string;
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  return [
    input.platform ?? process.platform,
    input.editorId,
    input.cacheDir,
    env.HOME ?? "",
    env.XDG_DATA_HOME ?? "",
    env.XDG_DATA_DIRS ?? "",
    env.LOCALAPPDATA ?? "",
    env.ProgramFiles ?? "",
    env.ProgramW6432 ?? "",
    env.SystemDrive ?? "",
    resolvePathEnvironmentVariable(env),
    env.PATHEXT ?? "",
  ].join("\0");
}

export async function resolveCachedEditorIcon(input: {
  readonly editorId: string;
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<CachedEditorIcon | null> {
  const key = iconLookupCacheKey(input);
  const negativeUntil = negativeCache.get(key);
  if (negativeUntil !== undefined) {
    if (negativeUntil > Date.now()) return null;
    negativeCache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = resolveCachedEditorIconUncached(input)
    .catch(() => null)
    .then((icon) => {
      if (icon) {
        negativeCache.delete(key);
      } else {
        negativeCache.set(key, Date.now() + NEGATIVE_ICON_CACHE_TTL_MS);
      }
      return icon;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function clearEditorIconInFlightCache(): void {
  inFlight.clear();
  negativeCache.clear();
}
