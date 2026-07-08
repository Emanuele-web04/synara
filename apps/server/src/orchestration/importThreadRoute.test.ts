import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SERVER_SETTINGS, type ProviderStartOptions } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  claudeHistoricalSessionChildEnvironment,
  claudeHistoricalSessionEnvironment,
  resolveImportedThreadProviderOptionsForSettings,
} from "./importThreadRoute";

describe("claudeHistoricalSessionEnvironment", () => {
  it("expands instance Claude homes the same way session launches do", () => {
    const environment = claudeHistoricalSessionEnvironment({
      claudeAgent: {
        homePath: "~/claude-work",
        environment: { SYNARA_CLAUDE_IMPORT_TEST: "1" },
      },
    } satisfies ProviderStartOptions);

    expect(environment?.HOME).toBe(path.join(homedir(), "claude-work"));
    expect(environment?.SYNARA_CLAUDE_IMPORT_TEST).toBe("1");
  });

  it("expands instance Claude homes against the configured Synara home", () => {
    const environment = claudeHistoricalSessionEnvironment(
      {
        claudeAgent: {
          homePath: "~/claude-work",
          environment: { SYNARA_CLAUDE_IMPORT_TEST: "1" },
        },
      } satisfies ProviderStartOptions,
      { homeDir: "/synara/home" },
    );

    expect(environment?.HOME).toBe(path.join("/synara/home", "claude-work"));
    expect(environment?.SYNARA_CLAUDE_IMPORT_TEST).toBe("1");
  });

  it("scopes default Claude imports to the configured Synara home", () => {
    const environment = claudeHistoricalSessionEnvironment(undefined, {
      homeDir: "/synara/home",
    });

    expect(environment?.HOME).toBe("/synara/home");
  });

  it("passes the sanitized historical environment to child queries without remerging process env", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const environment = claudeHistoricalSessionChildEnvironment({
        HOME: "/tmp/synara-claude-import",
      });

      expect(environment).toEqual({ HOME: "/tmp/synara-claude-import" });
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});

describe("resolveImportedThreadProviderOptionsForSettings", () => {
  it("rejects disabled provider instances before import preflight can materialize options", () => {
    expect(() =>
      resolveImportedThreadProviderOptionsForSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            opencode_disabled: {
              driver: "opencode",
              enabled: false,
              config: {
                serverUrl: "http://127.0.0.1:4096",
                serverPassword: "must-not-be-used",
              },
            },
          },
        },
        { instanceId: "opencode_disabled", model: "opencode/model" },
      ),
    ).toThrow(/disabled for thread import/);
  });
});
