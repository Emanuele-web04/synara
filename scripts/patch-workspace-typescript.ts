import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// These workspaces use the legacy Effect language-service patch. Root
// postinstall owns the pass: Bun may run workspace prepare hooks concurrently
// even with --concurrent-scripts=1, and isolated installs share compiler files.
export const LEGACY_TYPESCRIPT_WORKSPACES = [
  "apps/server",
  "apps/web",
  "packages/contracts",
  "packages/shared",
  "scripts",
] as const;

export function patchWorkspaceTypeScript(root: string): void {
  const targets = new Map<string, { cli: string; cwd: string }>();
  for (const workspace of LEGACY_TYPESCRIPT_WORKSPACES) {
    // Resolve as the workspace would: hoisted installs can place dependencies
    // at the root, while isolated installs keep workspace links.
    const require = createRequire(join(root, workspace, "package.json"));
    let compiler: string;
    try {
      compiler = require.resolve("typescript/package.json");
    } catch (error) {
      // Filtered installs intentionally omit some workspace dependencies.
      if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    let cli: string;
    try {
      cli = require.resolve("@effect/language-service/cli.js");
    } catch (cause) {
      throw new Error(`Missing Effect language-service patcher for installed ${workspace}`, {
        cause,
      });
    }
    const directory = realpathSync(dirname(compiler));
    const patcher = realpathSync(cli);
    const previous = targets.get(directory);
    if (previous !== undefined && previous.cli !== patcher) {
      throw new Error(`Conflicting Effect language-service patchers for ${directory}`);
    }
    if (!previous) targets.set(directory, { cli: patcher, cwd: join(root, workspace) });
  }

  for (const [directory, { cli, cwd }] of targets) {
    // Await each real compiler's patch before starting another. execFileSync
    // propagates nonzero exits and signals, so later preparation cannot mask it.
    execFileSync(process.execPath, [cli, "patch", "--dir", directory], {
      // The CLI resolves its parsing API from cwd separately from --dir.
      // Preserve the workspace context used by the former prepare hook.
      cwd,
      stdio: "inherit",
    });
  }
}

if (import.meta.main) {
  patchWorkspaceTypeScript(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
