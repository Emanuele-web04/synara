export const DIFF_RENDER_SURFACE_SELECTOR = ".diff-render-surface";
export const DIFF_FILE_ANCHOR_SELECTOR = "[data-diff-file-path]";

export interface DiffFileAnchor {
  path: string;
  element: HTMLElement;
}

export function resolveDiffRenderSurface(viewport: HTMLElement | null): HTMLElement | null {
  if (!viewport) {
    return null;
  }
  return viewport.querySelector<HTMLElement>(DIFF_RENDER_SURFACE_SELECTOR);
}

export function readDiffFileAnchors(root: HTMLElement | null): DiffFileAnchor[] {
  if (!root) {
    return [];
  }
  const anchors: DiffFileAnchor[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(DIFF_FILE_ANCHOR_SELECTOR)) {
    const path = element.dataset.diffFilePath;
    if (path) {
      anchors.push({ path, element });
    }
  }
  return anchors;
}

export function readDiffFileOffsetTops(
  surface: HTMLElement,
  anchors: ReadonlyArray<DiffFileAnchor>,
): Map<string, number> {
  const surfaceTop = surface.getBoundingClientRect().top - surface.scrollTop;
  return new Map(
    anchors.map((anchor) => [anchor.path, anchor.element.getBoundingClientRect().top - surfaceTop]),
  );
}

export function findDiffFileAnchor(
  viewport: HTMLElement | null,
  filePath: string,
): HTMLElement | null {
  return readDiffFileAnchors(viewport).find((anchor) => anchor.path === filePath)?.element ?? null;
}

export function scrollDiffFileIntoView(
  viewport: HTMLElement | null,
  filePath: string,
  block: ScrollLogicalPosition,
): boolean {
  const anchor = findDiffFileAnchor(viewport, filePath);
  if (!anchor) {
    return false;
  }
  anchor.scrollIntoView({ block });
  return true;
}
