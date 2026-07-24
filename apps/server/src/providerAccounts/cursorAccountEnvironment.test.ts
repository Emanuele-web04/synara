// FILE: cursorAccountEnvironment.test.ts
// Purpose: Focused tests for the Cursor managed-account environment builder.
// Layer: Server unit tests

import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET, resolveAccountEnvironmentBuilder } from "./accountEnvironment";
import { buildCursorAccountEnvironment } from "./cursorAccountEnvironment";

const agentHome = "/accounts/cursor/2/agent/home";

describe("buildCursorAccountEnvironment", () => {
  it("registers itself for the cursor provider", () => {
    expect(resolveAccountEnvironmentBuilder("cursor")).toBe(buildCursorAccountEnvironment);
  });

  it("injects the managed API key and isolates the config dir", () => {
    const launch = buildCursorAccountEnvironment({
      provider: "cursor",
      ordinal: 2,
      authMethod: "apiKey",
      agentHome,
      apiKey: "key_managed",
    });
    expect(launch.environment.CURSOR_API_KEY).toBe("key_managed");
    expect(launch.environment.CURSOR_CONFIG_DIR).toBe(agentHome);
    expect(launch.profilePath).toBe(agentHome);
  });

  it("strips inherited Cursor auth overrides for OAuth launches", () => {
    const launch = buildCursorAccountEnvironment({
      provider: "cursor",
      ordinal: 2,
      authMethod: "oauth",
      agentHome,
    });
    expect(launch.environment.CURSOR_API_KEY).toBe(ACCOUNT_ENV_UNSET);
    expect(launch.environment.CURSOR_CONFIG_DIR).toBe(agentHome);
    expect(launch.profilePath).toBe(agentHome);
  });
});
