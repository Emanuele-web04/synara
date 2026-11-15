import { describe, expect, it } from "vitest";

import { affectedProjects, parsePushedRefs } from "./pre-push-check.ts";
import { TYPECHECK_PROJECTS } from "./typecheck.ts";

describe("pre-push check", () => {
  it("parses git's pre-push lines and keeps deletions recognizable", () => {
    expect(
      parsePushedRefs(
        "refs/heads/a 1111 refs/heads/a 2222\nrefs/heads/b 0000 refs/heads/b 3333\n\n",
      ),
    ).toEqual([
      { localOid: "1111", remoteOid: "2222" },
      { localOid: "0000", remoteOid: "3333" },
    ]);
  });

  it("type-checks only the projects that own the changed files", () => {
    expect(affectedProjects(["apps/server/src/index.ts", "README.md"])).toEqual(["apps/server"]);
    expect(affectedProjects(["apps/desktop/src/main.ts"])).toEqual([
      "apps/desktop",
      "apps/desktop/tsconfig.fixtures.json",
    ]);
    expect(affectedProjects(["apps/api/src/routes/v1.ts"])).toEqual([
      "apps/api",
      "apps/api/cloudflare/tsconfig.json",
    ]);
    expect(affectedProjects(["docs/release.md", "apps/web/public/logo.png"])).toEqual([]);
  });

  it("type-checks everything when shared code or configuration changes", () => {
    for (const file of [
      "packages/contracts/src/index.ts",
      "scripts/lib/env-bool.ts",
      "tsconfig.base.json",
      "bun.lock",
    ])
      expect(affectedProjects([file])).toEqual([...TYPECHECK_PROJECTS]);
  });
});
