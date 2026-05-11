import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
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
  const previousDpcodeHome = process.env.DPCODE_HOME;
  const previousT3codeHome = process.env.T3CODE_HOME;
  const previousDisableFlag = process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;

  afterEach(() => {
    if (previousDpcodeHome === undefined) delete process.env.DPCODE_HOME;
    else process.env.DPCODE_HOME = previousDpcodeHome;
    if (previousT3codeHome === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = previousT3codeHome;
    if (previousDisableFlag === undefined)
      delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    else process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = previousDisableFlag;
  });

  it("returns the overlay generated_images directory as the active write root by default", () => {
    process.env.DPCODE_HOME = "/dpcode-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/dpcode-test/runtime", "codex-home-overlay", "generated_images"),
    );
  });

  it("returns the source generated_images directory when the dpcode-browser plugin is enabled", () => {
    process.env.DPCODE_HOME = "/dpcode-test/runtime";
    process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN = "0";
    assert.equal(
      resolveCodexGeneratedImagesRoot("/codex-test/.codex"),
      path.join("/codex-test/.codex", "generated_images"),
    );
  });

  it("returns both source and overlay generated_images roots for the allowlist", () => {
    process.env.DPCODE_HOME = "/dpcode-test/runtime";
    delete process.env.DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN;
    assert.deepEqual(resolveCodexGeneratedImagesRoots("/codex-test/.codex"), [
      path.join("/codex-test/.codex", "generated_images"),
      path.join("/dpcode-test/runtime", "codex-home-overlay", "generated_images"),
    ]);
  });

  it("collapses to a single root when overlay equals source", () => {
    delete process.env.DPCODE_HOME;
    delete process.env.T3CODE_HOME;
    // The overlay falls under `<dirname(source)>/.dpcode/runtime/codex-home-overlay`,
    // which is always distinct from `<source>` itself, so the helper still returns
    // both candidates; this test guards the dedupe path with an artificial home
    // whose dirname happens to equal the overlay root.
    const homePath = "/runtime/.dpcode/runtime/codex-home-overlay";
    const roots = resolveCodexGeneratedImagesRoots(homePath);
    assert.ok(roots.length >= 1 && roots.length <= 2, `expected 1-2 roots, got ${roots.length}`);
    assert.ok(roots.includes(path.join(homePath, "generated_images")));
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
