import { describe, expect, it } from "vitest";

import {
  buildThreadImportCandidates,
  filterThreadImportTargetsByCapabilities,
} from "./threadImport";

describe("thread import targets", () => {
  it("keeps configured instances distinct instead of collapsing by provider kind", () => {
    const candidates = buildThreadImportCandidates([
      {
        instanceId: "codex",
        provider: "codex",
        driver: "codex",
        label: "Codex",
        enabled: true,
        isDefault: true,
        supported: true,
      },
      {
        instanceId: "codex_work",
        provider: "codex",
        driver: "codex",
        label: "Work",
        enabled: true,
        isDefault: false,
        supported: true,
      },
    ]);

    expect(candidates).toEqual([
      { provider: "codex", instanceId: "codex", label: "Codex" },
      { provider: "codex", instanceId: "codex_work", label: "Work" },
    ]);
  });

  it("filters each exact instance with its own capability result", () => {
    const candidates = buildThreadImportCandidates([
      {
        instanceId: "codex",
        provider: "codex",
        driver: "codex",
        label: "Codex",
        enabled: true,
        isDefault: true,
        supported: true,
      },
      {
        instanceId: "codex_work",
        provider: "codex",
        driver: "codex",
        label: "Work",
        enabled: true,
        isDefault: false,
        supported: true,
      },
    ]);

    expect(
      filterThreadImportTargetsByCapabilities(candidates, [
        {
          provider: "codex",
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: true,
          supportsPluginDiscovery: true,
          supportsRuntimeModelList: true,
          supportsThreadImport: false,
        },
        {
          provider: "codex",
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: true,
          supportsPluginDiscovery: true,
          supportsRuntimeModelList: true,
          supportsThreadImport: true,
        },
      ]),
    ).toEqual([{ provider: "codex", instanceId: "codex_work", label: "Work" }]);
  });
});
