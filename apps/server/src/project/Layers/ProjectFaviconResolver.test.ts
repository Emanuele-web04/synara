import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver";
import { ProjectFaviconResolverLive } from "./ProjectFaviconResolver";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "synara-project-favicon-",
  });
  return yield* fileSystem.realPath(directory);
});

const writeTextFile = Effect.fn(function* (cwd: string, relativePath: string, contents = "icon") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  it.effect("resolves fixed candidates in priority order before source declarations", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const candidates = [
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
      ];
      for (const candidate of candidates) yield* writeTextFile(cwd, candidate);
      yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand.svg">');
      yield* writeTextFile(cwd, "public/brand.svg");
      for (const candidate of candidates) {
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, candidate));
        yield* fileSystem.remove(path.join(cwd, candidate));
      }
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "public/brand.svg"));
    }),
  );

  it.effect("reads source files in priority order", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const sources = [
        "index.html",
        "public/index.html",
        "src/index.html",
        "app/root.tsx",
        "src/root.tsx",
        "app/routes/__root.tsx",
        "src/routes/__root.tsx",
      ];
      for (const [index, source] of sources.entries()) {
        yield* writeTextFile(cwd, source, `<link rel="icon" href="/brand-${index}.svg">`);
        yield* writeTextFile(cwd, `public/brand-${index}.svg`);
      }
      for (const [index, source] of sources.entries()) {
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, `public/brand-${index}.svg`));
        yield* fileSystem.remove(path.join(cwd, source));
        yield* fileSystem.remove(path.join(cwd, `public/brand-${index}.svg`));
      }
    }),
  );

  it.effect.each([
    ['<link rel="icon" href="/brand/logo.svg">', "public/brand/logo.svg"],
    [
      "<link href='/brand/logo.svg?version=2#icon' rel = 'shortcut icon' />",
      "public/brand/logo.svg",
    ],
    ['<link rel="icon" href="/brand/logo.svg#icon">', "brand/logo.svg"],
    ['[{ rel: "icon", href: "/brand/logo.svg?version=2" }]', "public/brand/logo.svg"],
    ["[{ href: '/brand/logo.svg#icon', rel: 'icon' }]", "public/brand/logo.svg"],
    ['<link rel="icon" href="..assets/logo.svg">', "..assets/logo.svg"],
  ] as const)("resolves the declared icon in %s", ([source, iconPath]) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "index.html", source);
      yield* writeTextFile(cwd, iconPath);
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, iconPath));
    }),
  );

  it.effect("prefers public hrefs and tries later declarations after invalid candidates", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(
        cwd,
        "index.html",
        '<link rel="icon" href="/missing.svg"><link rel="icon" href="/script.js"><link rel="icon" href="/brand.svg">',
      );
      yield* writeTextFile(cwd, "public/script.js");
      yield* writeTextFile(cwd, "brand.svg");
      yield* writeTextFile(cwd, "public/brand.svg");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "public/brand.svg"));
    }),
  );

  it.effect.each([
    '[{ rel: "icon" }, { href: "/brand.svg" }]',
    '<link rel="icon"><link href="/brand.svg">',
    '<link rel="icon" href="https://example.test/brand.svg">',
    '<link rel="icon" href="//example.test/brand.svg">',
    '<link rel="icon" href="file:///brand.svg">',
    '<link rel="icon" href="data:image/svg+xml,brand.svg">',
  ])("does not combine declarations or resolve remote hrefs in %s", (source) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "index.html", source);
      yield* writeTextFile(cwd, "public/brand.svg");
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect.each(["avif", "gif", "ico", "jpg", "jpeg", "png", "svg", "webp"])(
    "accepts declared %s icons",
    (extension) =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", `<link rel="icon" href="/brand.${extension}">`);
        yield* writeTextFile(cwd, `public/brand.${extension}`);
        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, `public/brand.${extension}`));
      }),
  );

  it.effect.each(["js", "html", "txt", "pdf", "bmp"])("rejects declared %s files", (extension) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "index.html", `<link rel="icon" href="/brand.${extension}">`);
      yield* writeTextFile(cwd, `public/brand.${extension}`);
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect("rejects hrefs outside the workspace", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const path = yield* Path.Path;
      const parent = yield* makeTempDir;
      const cwd = path.join(parent, "project");
      yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="../../outside.svg">');
      yield* writeTextFile(parent, "outside.svg");
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect.each(["favicon.svg", "index.html"])(
    "rejects %s symlinks outside the workspace",
    (name) =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, name, '<link rel="icon" href="/brand.svg">');
        yield* writeTextFile(cwd, "public/brand.svg");
        yield* fileSystem.symlink(path.join(outside, name), path.join(cwd, name));
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
  );

  it.effect("rejects declared assets through escaping directory symlinks", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const outside = yield* makeTempDir;
      yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand.svg">');
      yield* writeTextFile(outside, "brand.svg");
      yield* fileSystem.symlink(outside, path.join(cwd, "public"));
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect.each([
    ["favicon.svg", "script.js"],
    ["brand.txt", "logo.svg"],
  ] as const)("rejects a disallowed symlink path or target: %s", ([linkName, targetName]) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "index.html", `<link rel="icon" href="/${linkName}">`);
      yield* writeTextFile(cwd, targetName);
      yield* fileSystem.symlink(path.join(cwd, targetName), path.join(cwd, linkName));
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect("accepts confined icon symlinks and a symlinked workspace", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* makeTempDir;
      const cwd = path.join(parent, "project");
      const alias = path.join(parent, "workspace");
      yield* writeTextFile(cwd, "brand.svg");
      yield* fileSystem.symlink(path.join(cwd, "brand.svg"), path.join(cwd, "favicon.svg"));
      yield* fileSystem.symlink(cwd, alias);
      expect(yield* resolver.resolvePath(alias)).toBe(path.join(alias, "favicon.svg"));
    }),
  );

  it.effect.each([
    "apps/web/public/favicon.png",
    "web/public/favicon.png",
    "project-dashboard/public/favicon.png",
  ])("does not scan unlisted nested locations: %s", (nestedIcon) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, nestedIcon);
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect(
    "returns null for missing or relative workspaces and directories named like icons",
    () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "favicon.svg"));
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        expect(yield* resolver.resolvePath(path.join(cwd, "missing"))).toBeNull();
        expect(yield* resolver.resolvePath("")).toBeNull();
        expect(yield* resolver.resolvePath(".")).toBeNull();
      }),
  );

  it.effect("caches discovered icons for ten minutes without renewing the TTL on access", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "app/icon.svg");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "app/icon.svg"));
      yield* writeTextFile(cwd, "favicon.svg");
      yield* TestClock.adjust("9 minutes");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "app/icon.svg"));
      yield* TestClock.adjust("1 minute");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
    }),
  );

  it.effect("caches no-icon results for one minute across normalized workspace paths", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
      yield* writeTextFile(cwd, "favicon.svg");
      yield* TestClock.adjust("59 seconds");
      expect(yield* resolver.resolvePath(`${cwd}/.`)).toBeNull();
      yield* TestClock.adjust("1 second");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
    }),
  );

  it.effect.each(["deleted", "directory"])("invalidates a cached icon that is %s", (replacement) =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "favicon.svg");
      yield* writeTextFile(cwd, "favicon.ico");
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
      yield* fileSystem.remove(path.join(cwd, "favicon.svg"));
      if (replacement === "directory")
        yield* fileSystem.makeDirectory(path.join(cwd, "favicon.svg"));
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.ico"));
      yield* fileSystem.remove(path.join(cwd, "favicon.ico"));
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect("invalidates a cached symlink retargeted outside the workspace", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      const outside = yield* makeTempDir;
      yield* writeTextFile(cwd, "brand.svg");
      yield* writeTextFile(outside, "brand.svg");
      yield* fileSystem.symlink(path.join(cwd, "brand.svg"), path.join(cwd, "favicon.svg"));
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
      yield* fileSystem.remove(path.join(cwd, "favicon.svg"));
      yield* fileSystem.symlink(path.join(outside, "brand.svg"), path.join(cwd, "favicon.svg"));
      expect(yield* resolver.resolvePath(cwd)).toBeNull();
    }),
  );

  it.effect("evicts the least recently used entry after 512 workspaces", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* makeTempDir;
      const recent = path.join(parent, "project-0");
      const oldest = path.join(parent, "project-1");
      yield* fileSystem.makeDirectory(recent);
      yield* fileSystem.makeDirectory(oldest);
      expect(yield* resolver.resolvePath(recent)).toBeNull();
      expect(yield* resolver.resolvePath(oldest)).toBeNull();
      yield* writeTextFile(recent, "favicon.svg");
      yield* writeTextFile(oldest, "favicon.svg");
      for (let index = 2; index < 512; index += 1) {
        const cwd = path.join(parent, `project-${index}`);
        yield* writeTextFile(cwd, "favicon.svg");
        yield* resolver.resolvePath(cwd);
      }
      expect(yield* resolver.resolvePath(recent)).toBeNull();
      const last = path.join(parent, "project-512");
      yield* writeTextFile(last, "favicon.svg");
      yield* resolver.resolvePath(last);
      expect(yield* resolver.resolvePath(oldest)).toBe(path.join(oldest, "favicon.svg"));
      expect(yield* resolver.resolvePath(recent)).toBeNull();
    }),
  );
});
