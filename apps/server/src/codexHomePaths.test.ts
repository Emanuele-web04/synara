// FILE: codexHomePaths.test.ts
// Purpose: Verifies Codex source, overlay, account, and image-allowlist path isolation.
// Layer: Server path utility tests.

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

  it("keeps account-id-only homes isolated when the plugin is explicitly enabled", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      SYNARA_HOME: "/synara/runtime",
      DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
    };
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex",
    });

    assert.equal(
      resolveActiveCodexHomeWritePath({ env, accountId: "codex_2" }),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("keeps explicit shared homes isolated for non-default accounts when the plugin is enabled", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      SYNARA_HOME: "/synara/runtime",
      DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
    };
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex",
    });

    assert.equal(
      resolveActiveCodexHomeWritePath({
        env,
        homePath: "/users/me/.codex",
        accountId: "codex_2",
      }),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    );
  });

  it("keeps dedicated explicit account homes direct when the plugin is enabled", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: {
          CODEX_HOME: "/users/me/.codex",
          SYNARA_HOME: "/synara/runtime",
          DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0",
        },
        homePath: "/users/me/.codex-work",
        accountId: "codex_2",
      }),
      "/users/me/.codex-work",
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
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
      "/users/me/.codex_work",
    ]);
  });

  it("excludes default roots from account-id-only Codex homes", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" },
      homePath: "/users/me/.codex",
      accountId: "work",
      accountSourceHomeIsDedicated: false,
    });
    assert.deepEqual(candidates, [
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    ]);
  });

  it("keeps a dedicated account home alongside its account overlay", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "work",
      homePath: "/users/me/.codex-work",
    });
    const candidates = resolveCodexHomeAllowlistCandidates({
      env: { SYNARA_HOME: "/synara/runtime", CODEX_HOME: "/users/me/.codex" },
      homePath: "/users/me/.codex-work",
      accountId: "work",
      accountSourceHomeIsDedicated: true,
    });
    assert.deepEqual(candidates, [
      "/users/me/.codex-work",
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
    ]);
  });
});
