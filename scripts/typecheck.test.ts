import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TYPECHECK_PROJECTS, effectProjects } from "./typecheck.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function workspaceDirs(): string[] {
  const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: { packages: string[] };
  };
  return workspaces.packages.flatMap((pattern) =>
    pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern],
  );
}

describe("repository typecheck", () => {
  it("checks every workspace that has a tsconfig.json", () => {
    const expected = workspaceDirs().filter((dir) => existsSync(join(root, dir, "tsconfig.json")));
    expect(expected.length).toBeGreaterThan(10);
    for (const dir of expected) expect(TYPECHECK_PROJECTS).toContain(dir);
  });

  it("checks every extra project a package typecheck script compiles", () => {
    for (const dir of workspaceDirs()) {
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const scripts = (
        JSON.parse(readFileSync(manifest, "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts;
      for (const [name, command] of Object.entries(scripts ?? {})) {
        if (!name.startsWith("typecheck") || name === "typecheck:legacy") continue;
        for (const match of command.matchAll(/(?:--project|-p)\s+(\S+\.json)/g)) {
          expect(TYPECHECK_PROJECTS).toContain(`${dir}/${match[1]}`);
        }
      }
    }
  });

  it("runs Effect diagnostics wherever the language service plugin is configured", () => {
    expect(effectProjects()).toEqual(["apps/web", "packages/contracts", "scripts"]);
    expect(
      effectProjects((path) =>
        path.endsWith("apps/server/tsconfig.json")
          ? '{ "plugins": [{ "name": "@effect/language-service" }] }'
          : "{}",
      ),
    ).toEqual(["apps/server"]);
  });
});
