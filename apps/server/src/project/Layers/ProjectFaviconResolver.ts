import { Clock, Effect, FileSystem, Layer, Path } from "effect";

import { getProjectIconContentType } from "../../imageMime";
import { isContainedPath } from "../../workspace/realPathContainment";
import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver";

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "src/index.html",
  "app/root.tsx",
  "src/root.tsx",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
] as const;

const CACHE_CAPACITY = 512;
const ICON_CACHE_TTL_MS = 10 * 60 * 1_000;
const NO_ICON_CACHE_TTL_MS = 60 * 1_000;

interface ResolvedFile {
  readonly candidatePath: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number | undefined;
}

interface CachedIcon {
  readonly icon: ResolvedFile | null;
  readonly expiresAt: number;
}

function extractIconHrefs(source: string): string[] {
  const declarations: { index: number; href: string }[] = [];
  for (const match of source.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/\s(rel|href)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes.set(attribute[1]!.toLowerCase(), attribute[3]!);
    }
    const rel = attributes.get("rel")?.trim().toLowerCase();
    const href = attributes.get("href");
    if ((rel === "icon" || rel === "shortcut icon") && href) {
      declarations.push({ index: match.index, href });
    }
  }
  // Keep object declarations separate: a rel in one object must not combine
  // with an unrelated href in the next. Never evaluate repository source.
  for (const match of source.matchAll(/\{[^{}]*\}/g)) {
    const rel = match[0]
      .match(/(?:\{|,)\s*(?:rel|["']rel["'])\s*:\s*(["'])(.*?)\1/i)?.[2]
      ?.trim()
      .toLowerCase();
    const href = match[0].match(/(?:\{|,)\s*(?:href|["']href["'])\s*:\s*(["'])(.*?)\1/i)?.[2];
    if ((rel === "icon" || rel === "shortcut icon") && href) {
      declarations.push({ index: match.index, href });
    }
  }
  return declarations.toSorted((left, right) => left.index - right.index).map(({ href }) => href);
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Cache discovery, never bytes or permission to read a previously safe path.
  const cache = new Map<string, CachedIcon>();

  const cacheResult = (cwd: string, icon: ResolvedFile | null, now: number) => {
    cache.delete(cwd);
    cache.set(cwd, {
      icon,
      expiresAt: now + (icon ? ICON_CACHE_TTL_MS : NO_ICON_CACHE_TTL_MS),
    });
    if (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
  };

  const resolveFile = Effect.fn(function* (
    cwd: string,
    realRoot: string,
    candidatePath: string,
    isIcon: boolean,
  ) {
    if (candidatePath.includes("\0") || !isContainedPath(cwd, candidatePath)) return null;
    if (isIcon && !getProjectIconContentType(candidatePath)) return null;
    const realPath = yield* fileSystem
      .realPath(candidatePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!realPath || !isContainedPath(realRoot, realPath)) return null;
    if (isIcon && !getProjectIconContentType(realPath)) return null;
    const stats = yield* fileSystem.stat(realPath).pipe(Effect.catch(() => Effect.succeed(null)));
    return stats?.type === "File"
      ? { candidatePath, realPath, dev: stats.dev, ino: stats.ino }
      : null;
  });

  const findIcon = Effect.fn(function* (cwd: string, realRoot: string) {
    for (const candidate of FAVICON_CANDIDATES) {
      const icon = yield* resolveFile(cwd, realRoot, path.join(cwd, candidate), true);
      if (icon) return icon;
    }
    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = yield* resolveFile(cwd, realRoot, path.join(cwd, sourceFile), false);
      if (!sourcePath) continue;
      const source = yield* fileSystem
        .readFileString(sourcePath.realPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!source) continue;
      for (const href of extractIconHrefs(source)) {
        // Only local declarations may nominate an asset. URL schemes, network
        // paths and NULs are never filesystem instructions.
        const value = href.trim();
        if (/^(?:[a-z][\w+.-]*:|[\\/]{2})/i.test(value) || value.includes("\0")) continue;
        const clean = value.replace(/^\//, "").split(/[?#]/, 1)[0];
        if (!clean) continue;
        for (const candidate of [path.resolve(cwd, "public", clean), path.resolve(cwd, clean)]) {
          const icon = yield* resolveFile(cwd, realRoot, candidate, true);
          if (icon) return icon;
        }
      }
    }
    return null;
  });

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(function* (cwd) {
    if (!path.isAbsolute(cwd) || cwd.includes("\0")) return null;
    const normalizedCwd = path.resolve(cwd);
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(normalizedCwd);
    const fresh = cached && now < cached.expiresAt;
    if (fresh && cached.icon === null) {
      cache.delete(normalizedCwd);
      cache.set(normalizedCwd, cached);
      return null;
    }
    const realRoot = yield* fileSystem
      .realPath(normalizedCwd)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!realRoot) {
      cacheResult(normalizedCwd, null, now);
      return null;
    }
    if (fresh && cached.icon) {
      const current = yield* resolveFile(normalizedCwd, realRoot, cached.icon.candidatePath, true);
      if (
        current &&
        current.realPath === cached.icon.realPath &&
        current.dev === cached.icon.dev &&
        current.ino === cached.icon.ino
      ) {
        cache.delete(normalizedCwd);
        cache.set(normalizedCwd, cached);
        return current.candidatePath;
      }
    }
    cache.delete(normalizedCwd);
    const icon = yield* findIcon(normalizedCwd, realRoot);
    cacheResult(normalizedCwd, icon, now);
    return icon?.candidatePath ?? null;
  });

  return { resolvePath } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
