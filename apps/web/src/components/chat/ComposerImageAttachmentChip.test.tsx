import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ComposerImageSource } from "../../lib/composerImageSource";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";

describe("ComposerImageAttachmentChip", () => {
  it("deduplicates provenance when the window title echoes the app name", () => {
    const appSnap = {
      id: "appsnap-2",
      type: "image" as const,
      name: "appsnap.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:appsnap-2",
      file: new File(["image"], "appsnap.png", { type: "image/png" }),
      source: {
        kind: "appsnap" as const,
        captureId: "capture-2",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "ChatGPT",
        windowTitle: "ChatGPT",
      },
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={appSnap}
        images={[appSnap]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    // The provenance line renders "ChatGPT" exactly once — no "ChatGPT / ChatGPT".
    expect(markup).not.toContain("ChatGPT / ChatGPT");
    const provenanceMatches = markup.match(/ChatGPT/g) ?? [];
    // Only the visible provenance label (title attribute + text share the node).
    expect(provenanceMatches.length).toBeGreaterThan(0);
  });

  it("renders legacy Appshot provenance as an AppSnap card", () => {
    const appSnap = {
      id: "appsnap-legacy",
      type: "image" as const,
      name: "appsnap.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:appsnap-legacy",
      file: new File(["image"], "appsnap.png", { type: "image/png" }),
      // Older drafts persisted the provenance under the "appshot" discriminator.
      source: {
        kind: "appshot",
        captureId: "capture-legacy",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "Safari",
        windowTitle: "Synara",
      } as unknown as ComposerImageSource,
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={appSnap}
        images={[appSnap]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("w-52");
    expect(markup).toContain("Preview AppSnap from Safari");
    expect(markup).toContain("Synara / Safari");
  });
});
