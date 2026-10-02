// FILE: PullRequestMarkdown.tsx
// Purpose: Shared renderer for PR descriptions and comment bodies — GitHub-flavored bodies
//          pass through the pure preprocessing (template comments stripped, `<br>` tags
//          resolved) and `<details>` blocks render as native closed disclosures instead of
//          leaking literal tags and boilerplate walls into the view. Images open in the
//          shared fullscreen preview, navigable across the whole body.
// Layer: Pull request presentation
// Exports: PullRequestMarkdown

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ExpandedImageOverlay } from "~/components/chat/ExpandedImageOverlay";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { useExpandedImagePreview } from "~/components/chat/useExpandedImagePreview";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { cn } from "~/lib/utils";
import {
  preparePullRequestMarkdown,
  splitPullRequestMarkdownSections,
} from "./pullRequestMarkdown.logic";
import { PR_BODY_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

type ImageExpandHandler = (preview: ExpandedImagePreview, sourceImage?: HTMLImageElement) => void;

function DetailsSection({
  summary,
  body,
  cwd,
  onImageExpand,
}: {
  summary: string;
  body: string;
  cwd: string;
  onImageExpand: ImageExpandHandler;
}) {
  // Closed by default, matching GitHub: these blocks are boilerplate by convention.
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <CollapsibleTrigger
        className={cn(
          PR_META_TEXT_CLASS_NAME,
          "flex items-center gap-1 rounded px-1 py-0.5 text-left font-medium text-muted-foreground transition-colors hover:text-foreground",
        )}
      >
        <DisclosureChevron open={open} />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1 border-l border-border/60 pl-3">
          {body ? (
            <ChatMarkdown
              text={body}
              cwd={cwd}
              isStreaming={false}
              onImageExpand={onImageExpand}
              className={cn("pull-request-prose", PR_BODY_TEXT_CLASS_NAME)}
            />
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function PullRequestMarkdown({
  text,
  fallback,
  cwd,
}: {
  text: string;
  /** Rendered (as markdown) when the prepared body is empty. */
  fallback: string;
  cwd: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();
  // Widen the clicked image to every image currently rendered in this body, so the
  // preview can step through a PR's before/after screenshots.
  const expandImage: ImageExpandHandler = (preview, sourceImage) => {
    const elements = Array.from(
      containerRef.current?.querySelectorAll<HTMLImageElement>("img[data-expandable-image]") ?? [],
    );
    const index = sourceImage ? elements.indexOf(sourceImage) : -1;
    const images = elements.map((image) => ({
      src: image.getAttribute("src") ?? "",
      name: image.alt || "Image",
    }));
    setExpandedImage(index < 0 ? preview : { images, index });
  };
  const sections = splitPullRequestMarkdownSections(preparePullRequestMarkdown(text));
  if (sections.length === 0) {
    return (
      <ChatMarkdown
        text={fallback}
        cwd={cwd}
        isStreaming={false}
        className={cn("pull-request-prose", PR_BODY_TEXT_CLASS_NAME)}
      />
    );
  }
  return (
    <div ref={containerRef}>
      {sections.map((section, index) =>
        section.kind === "markdown" ? (
          <ChatMarkdown
            // Section order is stable for a given body; the body itself is the real key.
            // oxlint-disable-next-line no-array-index-key
            key={index}
            text={section.text}
            cwd={cwd}
            isStreaming={false}
            onImageExpand={expandImage}
            className={cn("pull-request-prose", PR_BODY_TEXT_CLASS_NAME)}
          />
        ) : (
          <DetailsSection
            // oxlint-disable-next-line no-array-index-key
            key={index}
            summary={section.summary}
            body={section.body}
            cwd={cwd}
            onImageExpand={expandImage}
          />
        ),
      )}
      {/* Portaled so the dock pane's clipping and transforms cannot trap the fixed overlay. */}
      {expandedImage
        ? createPortal(
            <ExpandedImageOverlay
              expandedImage={expandedImage}
              onClose={closeExpandedImage}
              onNavigate={navigateExpandedImage}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
