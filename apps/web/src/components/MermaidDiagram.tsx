// Mermaid stays in this lazy chunk; ordinary markdown does not load its renderers.
import mermaid from "mermaid";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Mermaid has process-global configuration. Serialize initialization with rendering so
// concurrent diagrams cannot change one another's theme or security configuration.
let renderQueue: Promise<void> = Promise.resolve();
let nextDiagramId = 0;
const MAX_DIAGRAM_LENGTH = 50_000;

interface DiagramImage {
  code: string;
  theme: "light" | "dark";
  url: string;
  widthEm: number;
  title: string;
}

export default function MermaidDiagram({
  code,
  theme,
  fallback,
}: {
  code: string;
  theme: "light" | "dark";
  fallback: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<DiagramImage | null>(null);

  useEffect(() => {
    if (!code.trim() || code.length > MAX_DIAGRAM_LENGTH) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    renderQueue = renderQueue
      .then(async () => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        const style = getComputedStyle(host);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
          fontFamily: style.fontFamily,
          fontSize,
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          maxTextSize: MAX_DIAGRAM_LENGTH,
          maxEdges: 500,
          suppressErrorRendering: true,
          // Source directives/frontmatter cannot override application-owned settings,
          // including themes, HTML handling, sanitizer options or resource limits.
          secure: Object.keys(mermaid.mermaidAPI.defaultConfig),
        });
        const container = document.createElement("div");
        container.setAttribute("aria-hidden", "true");
        Object.assign(container.style, {
          position: "fixed",
          left: "-100000px",
          top: "0",
          visibility: "hidden",
          pointerEvents: "none",
        });
        document.body.append(container);
        try {
          const id = `synara-mermaid-${++nextDiagramId}`;
          const { svg } = await mermaid.render(id, code, container);
          if (cancelled) return;
          const document = new DOMParser().parseFromString(svg, "image/svg+xml");
          const root = document.documentElement;
          const width = Number(root.getAttribute("viewBox")?.trim().split(/\s+/)[2]);
          if (root.localName !== "svg" || !Number.isFinite(width) || width <= 0) return;
          objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          setImage({
            code,
            theme,
            url: objectUrl,
            widthEm: width / fontSize,
            title: root.querySelector("title")?.textContent?.trim() || "Mermaid diagram",
          });
        } finally {
          container.remove();
        }
      })
      // Parse/load failures keep the copyable source and do not poison the render queue.
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [code, theme]);

  const currentImage = image?.code === code && image.theme === theme ? image : null;
  return (
    <div ref={hostRef}>
      {currentImage ? (
        <div className="flex justify-center p-3">
          {/* An SVG image is passive: no injected DOM, bound click handlers or scripts. */}
          <img
            src={currentImage.url}
            alt={currentImage.title}
            className="block h-auto max-w-full"
            style={{ width: `${currentImage.widthEm}em` }}
            onError={() => setImage(null)}
          />
        </div>
      ) : (
        fallback
      )}
    </div>
  );
}
