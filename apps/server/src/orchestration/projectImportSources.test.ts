import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { resolveProjectImportSources } from "./projectImportSources";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveProjectImportSources", () => {
  it("reads a non-default Claude account from its own config dir in a child environment", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "synara-import-sources-"));
    directories.push(stateDir);
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: {} },
        claude_team: { driver: "claudeAgent", config: { homePath: "/accounts/team" } },
      },
    };

    const sources = resolveProjectImportSources(settings, ["claudeAgent"], { stateDir });

    expect(sources.map((source) => source.instanceId)).toEqual([
      "claudeAgent",
      "claude_work",
      "claude_team",
    ]);
    const [defaultSource, work, team] = sources;
    expect(defaultSource?.claudeEnvironment).toBeUndefined();
    expect(work?.claudeConfigDir?.startsWith(stateDir)).toBe(true);
    expect(
      work?.claudeEnvironment?.CLAUDE_CONFIG_DIR ?? work?.claudeEnvironment?.HOME,
    ).toBeTruthy();
    expect(team?.claudeConfigDir).toBe(path.join("/accounts/team", ".claude"));
    expect(team?.providerOptions?.claudeAgent?.homePath).toBe("/accounts/team");
  });

  it("uses a Codex account's home override for discovery", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_work: { driver: "codex", config: { homePath: "/accounts/codex-work" } },
      },
    };

    const [, work] = resolveProjectImportSources(settings, ["codex"]);

    expect(work?.instanceId).toBe("codex_work");
    expect(work?.codexHomePath).toBe("/accounts/codex-work");
  });
});
