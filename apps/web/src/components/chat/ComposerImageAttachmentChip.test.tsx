import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import {
  buildExpandedImagePreview,
  extractBrowserAnnotationSelectedCode,
} from "./ExpandedImagePreview";

describe("ComposerImageAttachmentChip", () => {
  it("renders a compact thumbnail with preview and remove actions", () => {
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={{
          id: "image-1",
          type: "image",
          name: "CleanShot 2026-04-11 at 20.00.33@2x.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          previewUrl: "blob:image-1",
          file: new File(["image"], "CleanShot 2026-04-11 at 20.00.33@2x.png", {
            type: "image/png",
          }),
        }}
        images={[
          {
            id: "image-1",
            type: "image",
            name: "CleanShot 2026-04-11 at 20.00.33@2x.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            previewUrl: "blob:image-1",
            file: new File(["image"], "CleanShot 2026-04-11 at 20.00.33@2x.png", {
              type: "image/png",
            }),
          },
        ]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).toContain("size-16");
    expect(markup).toContain("Preview CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).toContain("Remove CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).not.toContain("h-14 w-14");
  });

  it("renders browser annotations as context cards while preserving preview", () => {
    const image = {
      id: "annotation-1",
      type: "image" as const,
      name: "browser-annotation-context.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:annotation-1",
      file: new File(["image"], "browser-annotation-context.png", {
        type: "image/png",
      }),
      source: "browser-annotation" as const,
      browserAnnotation: {
        promptBlock: [
          "<browser-drawing-selection>",
          "source: browser-annotation",
          "selectedElement:",
          "  selector: main > section.hero",
          "  outerHTML:",
          '    <section class="hero"><h1>Launch experiments</h1></section>',
          "</browser-drawing-selection>",
        ].join("\n"),
        title: "Northstar Studio",
        url: "http://localhost:8891/browser-editor-demo/index.html",
        strokeCount: 1,
        textCount: 2,
      },
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={image}
        images={[image]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("Live Editor Context");
    expect(markup).not.toContain(">Northstar Studio<");
    expect(markup).not.toContain("main &gt; section.hero");
    expect(markup).not.toContain("mt-0.5 flex min-w-0");
    expect(markup).toContain("tabler-icon-eye");
    expect(markup).not.toContain("tabler-icon-camera");
    expect(markup).not.toContain("1 stroke");
    expect(markup).not.toContain("2 notes");
    expect(markup).toContain("Preview live editor context Northstar Studio");
    expect(markup).toContain("Remove live editor context Northstar Studio");
    expect(markup).not.toContain("Preview browser-annotation-context.png");

    const expandedPreview = buildExpandedImagePreview([image], image.id);
    expect(expandedPreview?.images[0]?.name).toBe("Live Editor Context");
    expect(expandedPreview?.images[0]?.browserAnnotation?.promptBlock).toContain(
      "selectedElement:",
    );
    expect(
      extractBrowserAnnotationSelectedCode(
        expandedPreview?.images[0]?.browserAnnotation?.promptBlock ?? "",
      ),
    ).toBe('<section class="hero"><h1>Launch experiments</h1></section>');
  });
});
