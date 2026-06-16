import { describe, expect, it } from "vitest";

import {
  filterComposerAppSkills,
  parseComposerAppSkillInvocation,
  parseLiveEditAppSkillArgs,
} from "./composerAppSkills";

describe("composer app skills", () => {
  it("filters Live Edit from slash queries", () => {
    expect(filterComposerAppSkills("live")).toMatchObject([
      {
        id: "live-edit",
        trigger: "/live-edit",
      },
    ]);
  });

  it("parses direct Live Edit invocations", () => {
    expect(parseComposerAppSkillInvocation("/live-edit apps/web")).toEqual({
      id: "live-edit",
      args: "apps/web",
    });
  });

  it("parses Live Edit url, command, port, and target args", () => {
    expect(parseLiveEditAppSkillArgs("--url http://localhost:3000")).toEqual({
      url: "http://localhost:3000",
    });
    expect(parseLiveEditAppSkillArgs('--command "pnpm dev" --port 4173 apps/site')).toEqual({
      command: "pnpm dev",
      preferredPort: 4173,
      target: "apps/site",
    });
  });

  it("parses Live Edit stop and nuke actions", () => {
    expect(parseLiveEditAppSkillArgs("stop")).toEqual({ action: "stop" });
    expect(parseLiveEditAppSkillArgs("NUKE")).toEqual({ action: "nuke" });
  });
});
