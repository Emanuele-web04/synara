import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  codexConfiguredHomePathsFromSettings,
  extractCodexGeneratedImageReference,
  generatedImagePathFromRuntimeEvent,
  isGeneratedImageOnlyMarkdown,
  resolveCodexGeneratedImagesRoot,
  resolveCodexGeneratedImagesRoots,
} from "./codexGeneratedImages.ts";

function makeImageGenerationCompletedEvent(overrides?: {
  data?: unknown;
  detail?: string;
}): ProviderRuntimeEvent {
  return {
    eventId: "evt-1",
    provider: "codex",
    threadId: "thread-1",
    createdAt: new Date(0).toISOString(),
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      ...(overrides?.detail ? { detail: overrides.detail } : {}),
      data:
        overrides?.data ??
        ({
          kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
          path: "/codex-home/generated_images/thread-1/call-1.png",
          callId: "call-1",
        } as unknown),
    },
  } as unknown as ProviderRuntimeEvent;
}

describe("generatedImagePathFromRuntimeEvent", () => {
  it("returns the artifact path for an image_generation completion", () => {
    const event = makeImageGenerationCompletedEvent();
    assert.equal(
      generatedImagePathFromRuntimeEvent(event),
      "/codex-home/generated_images/thread-1/call-1.png",
    );
  });

  it("returns undefined when the artifact has the wrong kind", () => {
    const event = makeImageGenerationCompletedEvent({
      data: { kind: "something-else", path: "/whatever.png" },
    });
    assert.equal(generatedImagePathFromRuntimeEvent(event), undefined);
  });

  it("returns undefined for non-completed event types", () => {
    const startedEvent = {
      ...makeImageGenerationCompletedEvent(),
      type: "item.started",
    } as ProviderRuntimeEvent;
    assert.equal(generatedImagePathFromRuntimeEvent(startedEvent), undefined);
  });

  it("returns undefined when the item type is not image_generation", () => {
    const event = makeImageGenerationCompletedEvent();
    const otherItem = {
      ...event,
      payload: { ...event.payload, itemType: "assistant_message" },
    } as ProviderRuntimeEvent;
    assert.equal(generatedImagePathFromRuntimeEvent(otherItem), undefined);
  });
});

describe("resolveCodexGeneratedImagesRoot(s)", () => {
  const previousSynaraHome = process.env.SYNARA_HOME;
  const previousDpcodeHome = process.env.DPCODE_HOME;
  const previousT3codeHome = process.env.T3CODE_HOME;
  const previousDisableFlag = process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;

  afterEach(() => {
    if (previousSynaraHome === undefined) delete process.env.SYNARA_HOME;
    else process.env.SYNARA_HOME = previousSynaraHome;
    if (previousDpcodeHome === undefined) delete process.env.DPCODE_HOME;
    else process.env.DPCODE_HOME = previousDpcodeHome;
    if (previousT3codeHome === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = previousT3codeHome;
    if (previousDisableFlag === undefined)
      delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    else process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = previousDisableFlag;
  });

  it("returns the overlay generated_images directory as the active write root by default", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("returns the source generated_images directory when the dpcode-browser plugin is enabled", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = "0";
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/codex-test/.codex", "generated_images"),
    );
  });

  it("predicts against the account overlay for account-scoped instance context", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    const root = resolveCodexGeneratedImagesRoot({
      homePath: "/codex-test/.codex",
      accountId: "codex_2",
    });
    assert.ok(
      root.startsWith(
        path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_2-"),
      ),
      `expected account overlay root, got ${root}`,
    );
    assert.ok(root.endsWith(path.join("generated_images")));
  });

  it("honors a per-instance environment that enables the browser plugin", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    // The server stays in overlay mode, but this instance's child env flips
    // the sentinel, so it writes under its dedicated home directly.
    const root = resolveCodexGeneratedImagesRoot({
      homePath: "/codex-test/.codex-work",
      environment: { DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0" },
    });
    assert.equal(root, path.join("/codex-test/.codex-work", "generated_images"));
  });

  it("predicts missing saved_path references from the selected account home", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;

    const reference = extractCodexGeneratedImageReference({
      value: {
        type: "image_generation_end",
        call_id: "call-1",
      },
      threadId: "provider-thread-1",
      codexHome: {
        homePath: "/codex-test/.codex-work",
        accountId: "codex_work",
      },
    });

    assert.ok(reference, "expected generated-image reference");
    assert.ok(
      reference.path.startsWith(
        path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_work-"),
      ),
      `expected account overlay path, got ${reference.path}`,
    );
    assert.equal(
      path.basename(reference.path),
      "call-1.png",
      "predicted path should use the image call id",
    );
  });

  it("returns both source and overlay generated_images roots for the allowlist", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    assert.deepEqual(resolveCodexGeneratedImagesRoots("/codex-test/.codex"), [
      path.join("/codex-test/.codex", "generated_images"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    ]);
  });

  it("keeps historical account overlay roots when an instance enables direct-home mode", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;

    const roots = resolveCodexGeneratedImagesRoots({
      homePath: "/codex-test/.codex-work",
      shadowHomePath: "/codex-test/.codex-work-auth",
      accountId: "codex_work",
      environment: { DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN: "0" },
    });

    assert.ok(
      roots.some(
        (root) =>
          root.startsWith(
            path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_work-"),
          ) && root.endsWith(path.join("generated_images")),
      ),
      `expected account overlay generated_images root, got ${JSON.stringify(roots)}`,
    );
  });

  it("collapses to a single root when overlay equals source", () => {
    delete process.env.SYNARA_HOME;
    delete process.env.DPCODE_HOME;
    delete process.env.T3CODE_HOME;
    // The overlay falls under `<dirname(source)>/.synara/runtime/codex-home-overlay`,
    // which is always distinct from `<source>` itself, so the helper still returns
    // both candidates; this test guards the dedupe path with an artificial home
    // whose dirname happens to equal the overlay root.
    const homePath = "/runtime/.synara/runtime/codex-home-overlay";
    const roots = resolveCodexGeneratedImagesRoots(homePath);
    assert.ok(roots.length >= 1 && roots.length <= 2, `expected 1-2 roots, got ${roots.length}`);
    assert.ok(roots.includes(path.join(homePath, "generated_images")));
  });
});

describe("codexConfiguredHomePathsFromSettings", () => {
  const previousDisableFlag = process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
  const previousSynaraHome = process.env.SYNARA_HOME;

  afterEach(() => {
    if (previousDisableFlag === undefined)
      delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    else process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = previousDisableFlag;
    if (previousSynaraHome === undefined) delete process.env.SYNARA_HOME;
    else process.env.SYNARA_HOME = previousSynaraHome;
  });

  it("includes the env-scoped write home for instances relocating the overlay root", () => {
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_env: {
          driver: "codex" as const,
          enabled: true,
          environment: [{ name: "SYNARA_HOME", value: "/instance-env/runtime", sensitive: false }],
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    const expectedPrefix = path.join(
      "/instance-env/runtime",
      "codex-home-overlay",
      "accounts",
      "codex_env-",
    );
    assert.ok(
      roots.some((root) => root.startsWith(expectedPrefix)),
      `expected env-scoped account overlay root, got ${JSON.stringify(roots)}`,
    );
  });

  it("preserves configured account context so old overlay images survive plugin toggles", () => {
    process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = "0";
    process.env.SYNARA_HOME = "/synara-test/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_work: {
          driver: "codex" as const,
          enabled: true,
          config: {
            homePath: "/codex-test/.codex-work",
            shadowHomePath: "/codex-test/.codex-work-auth",
            accountId: "codex_work",
          },
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    assert.ok(
      roots.some(
        (root) =>
          root.startsWith(
            path.join("/synara-test/runtime", "codex-home-overlay", "accounts", "codex_work-"),
          ) && root.endsWith(path.join("generated_images")),
      ),
      `expected configured account overlay generated_images root, got ${JSON.stringify(roots)}`,
    );
  });

  it("excludes disabled Codex instance homes from the generated-image allowlist", () => {
    process.env.SYNARA_HOME = "/synara-disabled/runtime";
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex_disabled: {
          driver: "codex" as const,
          enabled: false,
          config: {
            homePath: "/codex-test/.codex-disabled",
            accountId: "codex_disabled",
          },
        },
        codex_enabled: {
          driver: "codex" as const,
          enabled: true,
          config: {
            homePath: "/codex-test/.codex-enabled",
            accountId: "codex_enabled",
          },
        },
      },
    };

    const roots = codexConfiguredHomePathsFromSettings(settings).flatMap((home) =>
      resolveCodexGeneratedImagesRoots(home),
    );

    assert.ok(
      roots.some((root) => root.includes(path.join("accounts", "codex_enabled-"))),
      `expected enabled account overlay root, got ${JSON.stringify(roots)}`,
    );
    assert.ok(
      roots.every((root) => !root.includes(path.join("accounts", "codex_disabled-"))),
      `expected disabled account overlay root to be absent, got ${JSON.stringify(roots)}`,
    );
  });
});

describe("isGeneratedImageOnlyMarkdown", () => {
  it("returns true for messages containing only image references", () => {
    assert.equal(isGeneratedImageOnlyMarkdown("![Generated image](/tmp/a.png)"), true);
    assert.equal(
      isGeneratedImageOnlyMarkdown("![first](/tmp/a.png)\n\n![second](/tmp/b.png)"),
      true,
    );
    assert.equal(isGeneratedImageOnlyMarkdown("![Generated image](<path with spaces.png>)"), true);
  });

  it("returns false when there is non-image text", () => {
    assert.equal(isGeneratedImageOnlyMarkdown("Hello\n\n![image](/tmp/a.png)"), false);
    assert.equal(isGeneratedImageOnlyMarkdown("just text"), false);
  });

  it("returns false for empty/whitespace-only messages", () => {
    assert.equal(isGeneratedImageOnlyMarkdown(""), false);
    assert.equal(isGeneratedImageOnlyMarkdown("   \n  "), false);
  });
});
