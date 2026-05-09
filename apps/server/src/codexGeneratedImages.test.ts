import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  generatedImagePathFromRuntimeEvent,
  isGeneratedImageOnlyMarkdown,
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
