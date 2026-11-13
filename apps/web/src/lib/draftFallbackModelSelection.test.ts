import { DEFAULT_MODEL_BY_PROVIDER, ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { NewChatDefault } from "../appSettings";
import { resolveDraftFallbackModelSelection } from "./draftFallbackModelSelection";

function newChatDefault(
  defaultProvider: NewChatDefault["defaultProvider"],
  instanceId: string | null = null,
): NewChatDefault {
  return {
    defaultProvider,
    defaultProviderInstanceId: instanceId ? ProviderInstanceId.makeUnsafe(instanceId) : null,
  };
}

describe("resolveDraftFallbackModelSelection", () => {
  it("prefers an explicit project default over the settings default provider", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "codex", model: "gpt-5.5" },
        newChatDefault: newChatDefault("devin"),
      }),
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("uses the settings default provider when the project has no default", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        newChatDefault: newChatDefault("devin"),
      }),
    ).toEqual({ provider: "devin", model: "adaptive" });
  });

  it("starts on the settings default account only when the settings decide the provider", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        newChatDefault: newChatDefault("devin", "devin_work"),
      }),
    ).toEqual({ provider: "devin", instanceId: "devin_work", model: "adaptive" });
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "devin", model: "adaptive" },
        newChatDefault: newChatDefault("devin", "devin_work"),
      }),
    ).toEqual({ provider: "devin", model: "adaptive" });
  });

  it("falls back to codex when the settings default is pi and no project default exists", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        newChatDefault: newChatDefault("pi", "pi_work"),
      }),
    ).toEqual({ provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex });
  });

  it("uses the project default provider when the settings default is omp", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: { provider: "claudeAgent", model: "claude-sonnet-5" },
        newChatDefault: newChatDefault("omp"),
      }),
    ).toEqual({ provider: "claudeAgent", model: "claude-sonnet-5" });
  });

  it("falls back to codex when the settings default is omp and no project default exists", () => {
    expect(
      resolveDraftFallbackModelSelection({
        projectDefault: null,
        newChatDefault: newChatDefault("omp"),
      }),
    ).toEqual({ provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex });
  });
});
