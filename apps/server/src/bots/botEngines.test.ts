import { describe, expect, it } from "vitest";

import { rankBotProviders } from "./botEngines.ts";

const allEnabled = () => true;

describe("rankBotProviders", () => {
  it("keeps Codex then Claude first, and trusts an unknown status for them", () => {
    expect(rankBotProviders({ isEnabled: allEnabled, statuses: [] })).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });

  it("falls back to another available provider when neither Codex nor Claude can run", () => {
    expect(
      rankBotProviders({
        isEnabled: (provider) => provider !== "codex" && provider !== "claudeAgent",
        statuses: [
          { provider: "grok", available: true },
          { provider: "cursor", available: false },
        ],
      }),
    ).toEqual(["grok"]);
  });

  it("never falls back to a provider whose status is unknown, disabled, or without a default model", () => {
    expect(
      rankBotProviders({
        isEnabled: (provider) => provider !== "codex" && provider !== "droid",
        statuses: [
          { provider: "claudeAgent", available: false },
          { provider: "droid", available: true },
          { provider: "pi", available: true },
          { provider: "omp", available: true },
        ],
      }),
    ).toEqual([]);
  });
});
