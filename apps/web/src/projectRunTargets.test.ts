import { describe, expect, it } from "vitest";

import { selectPrimaryProjectRunCommand } from "./projectRunTargets";

describe("selectPrimaryProjectRunCommand", () => {
  it("prefers a saved regular project script over discovered dev", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: {
        cwd: "/repo",
        scripts: [
          {
            id: "serve",
            name: "Serve",
            command: "pnpm serve",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "dev", command: "pnpm run dev" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "saved",
      label: "Serve",
      command: "pnpm serve",
      cwd: "/repo",
    });
  });

  it("prefers discovered dev over start", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [
            { name: "start", command: "npm run start" },
            { name: "dev", command: "npm run dev" },
          ],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "dev",
      command: "npm run dev",
    });
  });

  it("falls back to discovered start when dev is unavailable", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo/apps/web",
          relativePath: "apps/web",
          packageJsonPath: "/repo/apps/web/package.json",
          scripts: [{ name: "start", command: "yarn start" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "apps/web start",
      command: "yarn start",
      cwd: "/repo/apps/web",
    });
  });

  it("returns null when there is no saved or discovered run command", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "build", command: "npm run build" }],
        },
      ],
    });

    expect(selected).toBeNull();
  });
});
