// FILE: piSdkImports.ts
// Purpose: Loads the Pi SDK packages from the `pi` CLI installation when they are not resolvable in-process.
// Layer: Provider runtime support
// Depends on: @synara/shared/executable.

import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveExecutable } from "@synara/shared/executable";

// Packaged builds ship the Pi SDK as an external, so the provider only works
// once the user installs the `pi` CLI. npm links bin shims into the package
// directory, while bun writes real shim scripts under ~/.bun/bin; both layouts
// are covered by walking ancestors and checking the well-known sibling dirs.
export async function piNodeModulesRoot(binaryPath: string): Promise<string | undefined> {
  let resolved = binaryPath;
  try {
    resolved = await realpath(binaryPath);
  } catch {
    // Fall back to the unresolved path; shim scripts still carry a usable dir.
  }
  const startDir = dirname(resolved);
  const roots = [
    join(startDir, "..", "lib", "node_modules"), // npm global prefix layout
    join(startDir, "..", "install", "global", "node_modules"), // bun global layout
  ];
  for (let current = startDir; ; ) {
    roots.push(join(current, "node_modules"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of roots) {
    try {
      await access(join(root, "@earendil-works", "pi-coding-agent", "package.json"));
      return root;
    } catch {
      // Candidate root does not host the SDK; keep walking.
    }
  }
  return undefined;
}

export async function piPackageEntry(moduleRoot: string, specifier: string): Promise<string> {
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const packageName = scoped
    ? `${segments[0] ?? ""}/${segments[1] ?? ""}`
    : (segments[0] ?? specifier);
  const subpath = segments.slice(scoped ? 2 : 1).join("/");
  const packageDir = join(moduleRoot, ...packageName.split("/"));
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
    main?: string;
    module?: string;
  };
  const key = subpath ? `./${subpath}` : ".";
  for (const [pattern, target] of Object.entries(manifest.exports ?? {})) {
    const entry =
      typeof target === "string"
        ? target
        : ((target as Record<string, unknown>)?.import ??
          (target as Record<string, unknown>)?.default);
    if (typeof entry !== "string") continue;
    if (pattern === key) return resolve(packageDir, entry);
    if (pattern.includes("*")) {
      const [pre = "", post = ""] = pattern.split("*");
      if (key.startsWith(pre) && key.endsWith(post)) {
        return resolve(
          packageDir,
          entry.replace("*", key.slice(pre.length, key.length - post.length)),
        );
      }
    }
  }
  if (!subpath) return resolve(packageDir, manifest.module ?? manifest.main ?? "dist/index.js");
  throw new Error(`Cannot resolve "${key}" of ${packageName} inside the installed Pi CLI.`);
}

export async function importPiPackage<M>(
  specifier: string,
  options?: { binaryPath?: string | undefined },
): Promise<M> {
  try {
    return (await import(specifier)) as M;
  } catch {
    // The SDK is not bundled into packaged builds; resolve it from the user's
    // `pi` CLI install instead.
  }
  const binary = options?.binaryPath ?? resolveExecutable("pi");
  if (!binary) {
    throw new Error(
      "Pi is not installed. Install it with `npm install -g @earendil-works/pi-coding-agent` or `bun install -g @earendil-works/pi-coding-agent`.",
    );
  }
  const moduleRoot = await piNodeModulesRoot(binary);
  if (!moduleRoot) {
    throw new Error(
      `Found the Pi CLI at ${binary} but could not locate @earendil-works packages next to it.`,
    );
  }
  return (await import(pathToFileURL(await piPackageEntry(moduleRoot, specifier)).href)) as M;
}
