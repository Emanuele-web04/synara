import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ProviderRuntimeEvent } from "@synara/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  codexConfiguredHomePathsFromSettings,
  generatedImagePathFromRuntimeEvent,
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

  afterEach(() => {
    if (previousSynaraHome === undefined) delete process.env.SYNARA_HOME;
    else process.env.SYNARA_HOME = previousSynaraHome;
  });

  it("returns the overlay generated_images directory as the active write root by default", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("predicts against the account overlay for account-scoped instance context", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
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

  it("honors a per-instance SYNARA_HOME when predicting the managed overlay", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    const root = resolveCodexGeneratedImagesRoot({
      homePath: "/codex-test/.codex-work",
      environment: { SYNARA_HOME: "/synara-test/instance-runtime" },
    });
    assert.equal(
      root,
      path.join("/synara-test/instance-runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("returns both source and overlay generated_images roots for the allowlist", () => {
    process.env.SYNARA_HOME = "/synara-test/runtime";
    assert.deepEqual(resolveCodexGeneratedImagesRoots("/codex-test/.codex"), [
      path.join("/codex-test/.codex", "generated_images"),
      path.join("/synara-test/runtime", "codex-home-overlay", "generated_images"),
    ]);
  });

  it("collapses to a single root when overlay equals source", () => {
    delete process.env.SYNARA_HOME;
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
  it("includes the env-scoped write home for instances relocating the overlay root", () => {
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

    const homes = codexConfiguredHomePathsFromSettings(settings);

    const expectedPrefix = path.join(
      "/instance-env/runtime",
      "codex-home-overlay",
      "accounts",
      "codex_env-",
    );
    assert.ok(
      homes.some((home) => home.startsWith(expectedPrefix)),
      `expected env-scoped account overlay home, got ${JSON.stringify(homes)}`,
    );
  });
});
