import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  resolveCodexHomeOverlayAccountSegment,
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveSynaraCodexHomeOverlayPath,
} from "./codexHomePaths.ts";

describe("Codex home paths", () => {
  it("resolves the source home using explicit, environment, then default precedence", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
    assert.ok(resolveBaseCodexHomePath({}).endsWith(`${path.sep}.codex`));
  });

  it("expands a leading tilde in explicit homes", () => {
    const result = resolveBaseCodexHomePath({}, "~/.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });

  it("anchors the overlay under SYNARA_HOME when set", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath({ SYNARA_HOME: "/synara/runtime" }, "/users/me/.codex"),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay beside the source home", () => {
    assert.equal(
      resolveSynaraCodexHomeOverlayPath({}, "/users/me/.codex"),
      path.join("/users/me", ".synara", "runtime", "codex-home-overlay"),
    );
  });
  it("derives nested account overlays when given an account segment", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });

    assert.ok(segment?.startsWith("work-"));
    assert.equal(
      resolveSynaraCodexHomeOverlayPath(
        { SYNARA_HOME: "/synara/runtime" },
        "/users/me/.codex",
        segment,
      ),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("does not create a nested account overlay for the explicit default account", () => {
    assert.equal(
      resolveCodexHomeOverlayAccountSegment({
        accountId: "default",
        homePath: "/users/me/.codex",
      }),
      undefined,
    );
  });

  it("uses the isolated overlay as Codex's write home", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { SYNARA_HOME: "/synara/runtime" },
        homePath: "/users/me/.codex",
      }),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("allowlists source and overlay homes when distinct", () => {
    assert.deepEqual(
      resolveCodexHomeAllowlistCandidates({
        env: { SYNARA_HOME: "/synara/runtime" },
        homePath: "/users/me/.codex",
      }),
      ["/users/me/.codex", path.join("/synara/runtime", "codex-home-overlay")],
    );
  });

  it("allowlists account-specific, legacy, source, and shadow homes", () => {
    const accountInput = {
      accountId: "work",
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    };
    const segment = resolveCodexHomeOverlayAccountSegment(accountInput);
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime" },
      ...accountInput,
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex",
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
      path.join("/synara/runtime", "codex-home-overlay"),
      "/users/me/.codex_work",
    ]);
  });

  it("includes account-scoped overlays for account-id-only Codex homes", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime" },
      homePath: "/users/me/.codex",
      accountId: "work",
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex",
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
      path.join("/synara/runtime", "codex-home-overlay"),
    ]);
  });
});
