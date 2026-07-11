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

  it("falls back to ~/.codex when nothing is provided", () => {
    const result = resolveBaseCodexHomePath({});
    assert.ok(result.endsWith(`${path.sep}.codex`));
  });

  it("expands a leading tilde in explicit homes", () => {
    const result = resolveBaseCodexHomePath({}, "~/.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });

  it("expands a Windows-style tilde home", () => {
    const result = resolveBaseCodexHomePath({}, "~\\.codex_work");

    assert.ok(result.endsWith(`${path.sep}.codex_work`));
    assert.ok(!result.startsWith("~"));
  });
});

describe("resolveSynaraCodexHomeOverlayPath", () => {
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
});

describe("resolveActiveCodexHomeWritePath", () => {
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

  it("keeps account-id-only homes isolated", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      SYNARA_HOME: "/synara/runtime",
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

  it("keeps explicit shared homes isolated for non-default accounts", () => {
    const env = {
      CODEX_HOME: "/users/me/.codex",
      SYNARA_HOME: "/synara/runtime",
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

  it("keeps dedicated explicit account homes in their account overlay", () => {
    const segment = resolveCodexHomeOverlayAccountSegment({
      accountId: "codex_2",
      homePath: "/users/me/.codex-work",
    });
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: {
          CODEX_HOME: "/users/me/.codex",
          SYNARA_HOME: "/synara/runtime",
        },
        homePath: "/users/me/.codex-work",
        accountId: "codex_2",
      }),
      path.join("/synara/runtime", "codex-home-overlay", "accounts", segment ?? ""),
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
      env: { SYNARA_HOME: "/users/me" },
      homePath: path.join("/users/me", "codex-home-overlay"),
    });
    assert.deepEqual(candidates, [path.join("/users/me", "codex-home-overlay")]);
  });

  it("includes the shadow home for account-scoped writes", () => {
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
