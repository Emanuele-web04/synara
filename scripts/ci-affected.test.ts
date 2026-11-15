import { describe, expect, it } from "vitest";

import { LANES, selectLanes } from "./ci-affected.ts";

const everything = Object.fromEntries(LANES.map((lane) => [lane, true]));

describe("CI lane selection", () => {
  it("never narrows the merge queue or main", () => {
    for (const event of ["merge_group", "push", "workflow_dispatch"])
      expect(selectLanes(event, ["apps/web/src/a.ts"], ["@synara/web"])).toEqual(everything);
  });

  it("runs every lane when CI, hooks, patches or root configuration change", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".githooks/pre-push",
      "patches/x.patch",
      "bun.lock",
      "package.json",
      "turbo.json",
      "tsconfig.base.json",
    ])
      expect(selectLanes("pull_request", [file], []), file).toEqual(everything);
  });

  it("keeps root prose out of the global rule", () => {
    expect(selectLanes("pull_request", ["README.md"], [])).toEqual(
      Object.fromEntries(LANES.map((lane) => [lane, false])),
    );
  });

  it("maps turbo's affected packages to the lanes that test them", () => {
    expect(
      selectLanes("pull_request", ["apps/web/src/a.ts"], ["@synara/web", "@synara/cli"]),
    ).toEqual({
      core: false,
      web: true,
      server: true,
      build: true,
      windows: true,
    });
    expect(selectLanes("pull_request", ["apps/web/src/a.ts"], ["@synara/web"])).toEqual({
      core: false,
      web: true,
      server: false,
      build: true,
      windows: false,
    });
  });

  it("adds the dependencies turbo's package graph cannot see", () => {
    expect(
      selectLanes("pull_request", ["scripts/lib/env-bool.ts"], ["@synara/scripts"]),
    ).toMatchObject({
      core: true,
      server: true,
      build: true,
    });
  });
});
