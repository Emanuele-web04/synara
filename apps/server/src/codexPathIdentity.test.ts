// FILE: codexPathIdentity.test.ts
// Purpose: Verifies Codex path identity across direct and parent-component aliases.
// Layer: Server filesystem utility tests.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { codexPathsReferenceSameLocation, resolveCodexPathIdentity } from "./codexPathIdentity.ts";

describe("Codex path identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches homes reached through a symlinked parent component", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-codex-path-identity-"));
    roots.push(root);
    const realParent = path.join(root, "real-parent");
    const realHome = path.join(realParent, "codex-home");
    const parentAlias = path.join(root, "parent-alias");
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realParent, parentAlias, "dir");

    assert.equal(
      codexPathsReferenceSameLocation(realHome, path.join(parentAlias, "codex-home")),
      true,
    );
  });

  it("preserves missing tails beneath the nearest real parent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-codex-path-missing-"));
    roots.push(root);
    const realParent = path.join(root, "real-parent");
    const parentAlias = path.join(root, "parent-alias");
    mkdirSync(realParent, { recursive: true });
    symlinkSync(realParent, parentAlias, "dir");

    assert.equal(
      resolveCodexPathIdentity(path.join(parentAlias, "future", "codex-home")),
      resolveCodexPathIdentity(path.join(realParent, "future", "codex-home")),
    );
  });
});
