// FILE: MarkdownMermaidDiagram.tsx
// Purpose: Render Mermaid markdown fences with theme-aware, serialized Mermaid runtime access.
// Layer: Web chat markdown presentation helper
// Exports: MarkdownMermaidDiagram, isMermaidFence

import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import type { CodeFenceInfo } from "../../lib/codeFence";
import type { DiffThemeName } from "../../lib/diffRendering";

export function isMermaidFence(fence: CodeFenceInfo): boolean {
  return !fence.isFileReference && fence.language.toLowerCase() === "mermaid";
}

let mermaidRenderQueue = Promise.resolve();

function enqueueMermaidRender(input: {
  code: string;
  renderId: string;
  themeName: DiffThemeName;
}): Promise<string> {
  const renderTask = async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: input.themeName === "github-dark" ? "dark" : "default",
      flowchart: { htmlLabels: false },
    });

    const rendered = await mermaid.render(input.renderId, input.code);
    return rendered.svg;
  };

  const renderPromise = mermaidRenderQueue.then(renderTask, renderTask);
  mermaidRenderQueue = renderPromise.then(
    () => undefined,
    () => undefined,
  );
  return renderPromise;
}

export function MarkdownMermaidDiagram({
  code,
  themeName,
  fallback,
}: {
  code: string;
  themeName: DiffThemeName;
  fallback: ReactNode;
}) {
  const reactId = useId();
  const renderId = useMemo(
    () => `chat-mermaid-${reactId.replaceAll(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const [svg, setSvg] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setHasError(false);

    void enqueueMermaidRender({ code, renderId, themeName })
      .then((renderedSvg) => {
        if (!cancelled) {
          setSvg(renderedSvg);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(
            "Mermaid rendering failed, falling back to source.",
            error instanceof Error ? error.message : error,
          );
          setHasError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, renderId, themeName]);

  if (hasError) {
    return fallback;
  }

  return (
    <div className="chat-markdown-mermaid" data-chat-mermaid={svg ? "rendered" : "pending"}>
      {svg ? (
        <div className="chat-markdown-mermaid__svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="chat-markdown-mermaid__loading" aria-label="Rendering Mermaid diagram" />
      )}
    </div>
  );
}
