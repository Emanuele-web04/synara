// FILE: botHubs.test.ts
// Purpose: Which Hubs the Hubs UI lists next to SynBot: every Hub but the bots, and none until
//          SynBot's first snapshot says which Hubs are bots.
// Layer: SynBot state tests

import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { botProjectIdsOf, withoutBotHubs } from "./botHubs";

const hub = ProjectId.makeUnsafe("hub");
const bot = ProjectId.makeUnsafe("bot");
const projects = [{ id: hub }, { id: bot }];

describe("bot Hubs", () => {
  it("are unknown until SynBot has loaded", () => {
    expect(botProjectIdsOf("idle", [{ id: bot }])).toBeNull();
    expect(botProjectIdsOf("loading", [{ id: bot }])).toBeNull();
    expect(withoutBotHubs(projects, null)).toEqual([]);
  });

  it("leave the Hubs UI once known", () => {
    const ids = botProjectIdsOf("ready", [{ id: bot }]);
    expect(withoutBotHubs(projects, ids)).toEqual([{ id: hub }]);
  });

  it("are none where the host has no SynBot", () => {
    expect(withoutBotHubs(projects, botProjectIdsOf("unavailable", []))).toEqual(projects);
  });
});
