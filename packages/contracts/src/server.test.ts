import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  COMPOSER_PREDICTION_MAX_CHARS,
  ServerGenerateComposerPredictionResult,
  ServerGetEnvironmentResult,
  ServerProviderStatus,
} from "./server";

const decodeServerProviderStatus = Schema.decodeUnknownSync(ServerProviderStatus);
const decodeServerEnvironment = Schema.decodeUnknownSync(ServerGetEnvironmentResult);

describe("ServerProviderStatus", () => {
  it("promotes legacy provider-only snapshots to the default provider instance", () => {
    const parsed = decodeServerProviderStatus({
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("codex");
    expect(parsed.driver).toBe("codex");
    expect(parsed.instanceId).toBe("codex");
  });

  it("preserves exact instance identity for same-driver provider snapshots", () => {
    const parsed = decodeServerProviderStatus({
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claude_work",
      displayName: "Claude Work",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.driver).toBe("claudeAgent");
    expect(parsed.instanceId).toBe("claude_work");
    expect(parsed.displayName).toBe("Claude Work");
  });
});

describe("ServerGetEnvironmentResult", () => {
  it("decodes the composer predictions capability from older and newer servers", () => {
    const descriptor = {
      environmentId: "environment-1",
      label: "Mini",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.5.0",
      capabilities: { repositoryIdentity: true },
    };
    const withCapability = (composerPredictions: boolean) =>
      decodeServerEnvironment({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, composerPredictions },
      }).capabilities.composerPredictions;

    expect(decodeServerEnvironment(descriptor).capabilities.composerPredictions).toBeUndefined();
    expect(withCapability(true)).toBe(true);
    expect(withCapability(false)).toBe(false);
  });
});

describe("ServerGenerateComposerPredictionResult", () => {
  const decode = Schema.decodeUnknownSync(ServerGenerateComposerPredictionResult);

  it("accepts a suggestion of up to about three sentences and no longer", () => {
    const longest = "a".repeat(COMPOSER_PREDICTION_MAX_CHARS);

    expect(COMPOSER_PREDICTION_MAX_CHARS).toBe(320);
    expect(decode({ suggestion: longest })).toEqual({ suggestion: longest });
    expect(decode({ suggestion: null })).toEqual({ suggestion: null });
    expect(() => decode({ suggestion: `${longest}a` })).toThrow();
  });
});
