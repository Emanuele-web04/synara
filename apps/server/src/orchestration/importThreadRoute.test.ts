import { homedir } from "node:os";
import path from "node:path";

import type { ProviderStartOptions } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  claudeHistoricalSessionChildEnvironment,
  claudeHistoricalSessionEnvironment,
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
