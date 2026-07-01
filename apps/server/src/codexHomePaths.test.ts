import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  resolveCodexHomeOverlayAccountSegment,
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveDpCodeCodexHomeOverlayPath,
  shouldDisableDpCodeBrowserPlugin,
} from "./codexHomePaths.ts";

describe("resolveBaseCodexHomePath", () => {
  it("prefers the explicit home path over CODEX_HOME and the default", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
  });

  it("falls back to CODEX_HOME when no explicit home is supplied", () => {
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
  });

  it("falls back to ~/.codex when nothing is provided", () => {
    const result = resolveBaseCodexHomePath({});
    assert.ok(result.endsWith(`${path.sep}.codex`));
  });

  it("expands a leading tilde in explicit homes", () => {
    const result = resolveBaseCodexHomePath({}, "~/.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });
});

describe("resolveDpCodeCodexHomeOverlayPath", () => {
  it("anchors the overlay under SYNARA_HOME when set", () => {
    assert.equal(
      resolveDpCodeCodexHomeOverlayPath({ SYNARA_HOME: "/synara/runtime" }, "/users/me/.codex"),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("honours the legacy DPCODE_HOME variable", () => {
    assert.equal(
      resolveDpCodeCodexHomeOverlayPath({ DPCODE_HOME: "/dp/runtime" }, "/users/me/.codex"),
      path.join("/dp/runtime", "codex-home-overlay"),
    );
  });

  it("honours the legacy T3CODE_HOME variable", () => {
    assert.equal(
      resolveDpCodeCodexHomeOverlayPath({ T3CODE_HOME: "/t3/runtime" }, "/users/me/.codex"),
      path.join("/t3/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay sibling of the source home", () => {
    assert.equal(
      resolveDpCodeCodexHomeOverlayPath({}, "/users/me/.codex"),
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
      resolveDpCodeCodexHomeOverlayPath(
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
});

describe("shouldDisableDpCodeBrowserPlugin", () => {
  it("disables the plugin (overlay active) by default", () => {
    assert.equal(shouldDisableDpCodeBrowserPlugin({}), true);
  });

  it("respects the explicit '0' opt-out", () => {
    assert.equal(
      shouldDisableDpCodeBrowserPlugin({ DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0" }),
      false,
    );
  });
});

describe("resolveActiveCodexHomeWritePath", () => {
  it("returns the overlay home when the plugin is disabled (default)", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { SYNARA_HOME: "/synara/runtime" },
        homePath: "/users/me/.codex",
      }),
      path.join("/synara/runtime", "codex-home-overlay"),
    );
  });

  it("returns the source home when the plugin is explicitly enabled", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: {
          DPCODE_HOME: "/dp/runtime",
          DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
        },
        homePath: "/users/me/.codex",
      }),
      "/users/me/.codex",
    );
  });
});

describe("resolveCodexHomeAllowlistCandidates", () => {
  it("includes both source and overlay homes when distinct", () => {
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime" },
      homePath: "/users/me/.codex",
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex",
      path.join("/synara/runtime", "codex-home-overlay"),
    ]);
  });

  it("returns just the source when overlay equals source", () => {
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { DPCODE_HOME: "/users/me" },
      homePath: path.join("/users/me", "codex-home-overlay"),
    });
    assert.deepEqual(candidates, [path.join("/users/me", "codex-home-overlay")]);
  });

  it("includes the shadow home for direct account writes", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime" },
      homePath: "/users/me/.codex",
      shadowHomePath: "/users/me/.codex_work",
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex",
      path.join("/synara/runtime", "codex-home-overlay"),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
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
      path.join("/synara/runtime", "codex-home-overlay"),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    ]);
  });
});
