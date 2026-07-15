// FILE: promptReferenceProjection.test.ts
// Purpose: Verifies structured composer references remain meaningful in text-only provider prompts.
// Layer: Provider prompt compatibility tests

import { describe, expect, it } from "vitest";

import { appendProviderReferencesPromptBlock } from "./promptReferenceProjection.ts";

describe("appendProviderReferencesPromptBlock", () => {
  it("projects Factory plugin and local path mentions without changing the user text", () => {
    const result = appendProviderReferencesPromptBlock({
      text: "Review this",
      mentions: [
        { name: "security-engineer", path: "plugin://security-engineer@factory-plugins" },
        { name: "auth.ts", path: "/workspace/src/auth.ts" },
      ],
    });

    expect(result).toContain("Review this");
    expect(result).toContain("Factory plugin");
    expect(result).toContain("plugin://security-engineer@factory-plugins");
    expect(result).toContain("local path");
    expect(result).toContain("/workspace/src/auth.ts");
  });

  it("returns the original text when no references were selected", () => {
    expect(appendProviderReferencesPromptBlock({ text: "Hello", mentions: [] })).toBe("Hello");
  });
});
