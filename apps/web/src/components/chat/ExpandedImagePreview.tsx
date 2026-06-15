import type {
  ComposerBrowserAnnotationContext,
  ComposerBrowserContextAttachment,
} from "../../composerDraftStore";

export interface ExpandedImageItem {
  src?: string;
  name: string;
  browserAnnotation?: ComposerBrowserAnnotationContext;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

function expandedImageDisplayName(image: {
  name: string;
  source?: string;
}): string {
  return image.source === "browser-annotation" ? "Live Editor Context" : image.name;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string;
    source?: string;
    browserAnnotation?: ComposerBrowserAnnotationContext;
  }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl
      ? [
          {
            id: image.id,
            src: image.previewUrl,
            name: expandedImageDisplayName(image),
            browserAnnotation:
              image.source === "browser-annotation" ? image.browserAnnotation : undefined,
          },
        ]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
      ...(image.browserAnnotation ? { browserAnnotation: image.browserAnnotation } : {}),
    })),
    index: selectedIndex,
  };
}

export function buildExpandedBrowserContextPreview(
  contexts: ReadonlyArray<ComposerBrowserContextAttachment>,
  selectedContextId: string,
): ExpandedImagePreview | null {
  const previewableContexts = contexts.map((context) => ({
    id: context.id,
    browserAnnotation: {
      promptBlock: context.promptBlock,
      title: context.title,
      url: context.url,
      strokeCount: context.strokeCount,
      textCount: context.textCount,
      ...(context.arrowCount ? { arrowCount: context.arrowCount } : {}),
      ...(context.selectedSelector ? { selectedSelector: context.selectedSelector } : {}),
    } satisfies ComposerBrowserAnnotationContext,
  }));
  if (previewableContexts.length === 0) {
    return null;
  }
  const selectedIndex = previewableContexts.findIndex((context) => context.id === selectedContextId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableContexts.map((context) => ({
      name: "Live Editor Context",
      browserAnnotation: context.browserAnnotation,
    })),
    index: selectedIndex,
  };
}

export function buildExpandedLiveEditorContextPreview(input: {
  images: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string;
    source?: string;
    browserAnnotation?: ComposerBrowserAnnotationContext;
  }>;
  contexts: ReadonlyArray<ComposerBrowserContextAttachment>;
  promptBlock: string;
}): ExpandedImagePreview | null {
  const annotationImage = input.images.find(
    (image) => image.source === "browser-annotation" && image.previewUrl,
  );
  const firstAnnotation = input.images.find((image) => image.browserAnnotation)?.browserAnnotation;
  const firstContext = input.contexts[0];
  const context = {
    promptBlock: input.promptBlock,
    title:
      firstAnnotation?.title ||
      firstContext?.title ||
      annotationImage?.name ||
      "Live Editor Context",
    url: firstAnnotation?.url || firstContext?.url || "",
    strokeCount: firstAnnotation?.strokeCount ?? 0,
    textCount: firstAnnotation?.textCount ?? 0,
    arrowCount: firstAnnotation?.arrowCount ?? 0,
    selectedSelector:
      firstAnnotation?.selectedSelector ||
      firstContext?.selectedSelector ||
      undefined,
  } satisfies ComposerBrowserAnnotationContext;
  return {
    images: [
      {
        name: "Live Editor Context",
        ...(annotationImage?.previewUrl ? { src: annotationImage.previewUrl } : {}),
        browserAnnotation: context,
      },
    ],
    index: 0,
  };
}

export function extractBrowserAnnotationSelectedCode(promptBlock: string): string | null {
  const lines = promptBlock.split("\n");
  const outerHtmlLineIndex = lines.findIndex((line) => line.trim() === "outerHTML:");
  if (outerHtmlLineIndex < 0) {
    return null;
  }

  const codeLines: string[] = [];
  for (const line of lines.slice(outerHtmlLineIndex + 1)) {
    if (line.startsWith("    ")) {
      codeLines.push(line.slice(4));
      continue;
    }
    if (line.startsWith("</browser-")) {
      break;
    }
    if (codeLines.length === 0 && line.trim().length > 0) {
      codeLines.push(line);
      continue;
    }
    break;
  }

  const code = codeLines.join("\n").trim();
  return code.length > 0 && code !== "(empty)" ? code : null;
}
