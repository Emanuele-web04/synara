import { describe, expect, it } from "vitest";

import {
  providerCommandsQueryOptions,
  providerDiscoveryQueryKeys,
  providerSkillsQueryOptions,
} from "./providerDiscoveryReactQuery";

// Skill/command discovery is query-independent: the server returns the full list
// for a cwd and the composer filters client-side. Keeping the typed query out of
// the cache key is what makes search instant — every keystroke hits the same
// cached list instead of refetching. These guard against re-introducing a
// per-keystroke fetch by putting a search string back in the key.
describe("provider discovery query keys are search-independent", () => {
  it("skills key does not vary with what the user types", () => {
    const key = providerDiscoveryQueryKeys.skills("codex", "/repo", null);
    expect(key).toEqual(["provider-discovery", "skills", "codex", "/repo", null]);
    // No element is a free-text search term.
    expect(key).not.toContain("rea");
  });

  it("commands key does not vary with what the user types", () => {
    const key = providerDiscoveryQueryKeys.commands("codex", "/repo", null);
    expect(key).toEqual(["provider-discovery", "commands", "codex", "/repo", null, null]);
  });

  it("two skill option builds for the same workspace share one cache key", () => {
    // Stands in for two keystrokes ("re" then "rev"): both must resolve to the
    // same cache entry so no network round-trip happens while typing.
    const a = providerSkillsQueryOptions({ provider: "codex", cwd: "/repo" });
    const b = providerSkillsQueryOptions({ provider: "codex", cwd: "/repo" });
    expect(a.queryKey).toEqual(b.queryKey);
  });

  it("can defer skill discovery while keeping the same cache key", () => {
    const deferred = providerSkillsQueryOptions({
      provider: "codex",
      cwd: "/repo",
      enabled: false,
    });
    const enabled = providerSkillsQueryOptions({
      provider: "codex",
      cwd: "/repo",
      enabled: true,
    });
    expect(deferred.queryKey).toEqual(enabled.queryKey);
    expect(deferred.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
  });

  it("two command option builds for the same workspace share one cache key", () => {
    const a = providerCommandsQueryOptions({ provider: "codex", cwd: "/repo" });
    const b = providerCommandsQueryOptions({ provider: "codex", cwd: "/repo" });
    expect(a.queryKey).toEqual(b.queryKey);
  });
});
