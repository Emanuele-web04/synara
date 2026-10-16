import type { QueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface EditorViewHandoff {
  target: "editor" | "preview";
  lineNumber: number;
  lineFraction: number;
  scrollLeft: number;
  selection?: { start: number; end: number };
}
// Presentation only: no document contents, save state, or persistent user data.
const handoffs = new WeakMap<QueryClient, Map<string, EditorViewHandoff>>();
const keyOf = (cwd: string, filePath: string) => JSON.stringify([cwd, filePath]);
export function rememberEditorView(
  client: QueryClient,
  cwd: string,
  filePath: string,
  view: EditorViewHandoff,
): void {
  let views = handoffs.get(client);
  if (!views) {
    views = new Map();
    handoffs.set(client, views);
  }
  const key = keyOf(cwd, filePath);
  views.delete(key);
  views.set(key, view);
  if (views.size > 100) views.delete(views.keys().next().value!);
}
export function takeEditorView(
  client: QueryClient,
  cwd: string,
  filePath: string,
  target: EditorViewHandoff["target"],
): EditorViewHandoff | undefined {
  const views = handoffs.get(client),
    key = keyOf(cwd, filePath);
  const view = views?.get(key);
  if (view?.target !== target) return undefined;
  views?.delete(key);
  return view;
}
function previewGeometry(container: HTMLElement) {
  const code = container.querySelector<HTMLElement>("pre code");
  const line = code?.querySelector<HTMLElement>(".line");
  if (!code || !line) return undefined;
  const lineHeight =
    Number.parseFloat(getComputedStyle(line).lineHeight) ||
    Number.parseFloat(getComputedStyle(code).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return undefined;
  const inset =
    line.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  return { code, lineHeight, inset };
}
export function capturePreviewView(container: HTMLElement): EditorViewHandoff | undefined {
  const geometry = previewGeometry(container);
  if (!geometry) return undefined;
  const position = Math.max(0, (container.scrollTop - geometry.inset) / geometry.lineHeight);
  const view: EditorViewHandoff = {
    target: "editor",
    lineNumber: Math.floor(position) + 1,
    lineFraction: position % 1,
    scrollLeft: container.scrollLeft,
  };
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const selected = selection.getRangeAt(0);
    if (
      geometry.code.contains(selected.startContainer) &&
      geometry.code.contains(selected.endContainer)
    ) {
      const prefix = document.createRange();
      prefix.selectNodeContents(geometry.code);
      prefix.setEnd(selected.startContainer, selected.startOffset);
      const start = prefix.toString().length;
      view.selection = { start, end: start + selected.toString().length };
    }
  }
  return view;
}

/** Keep the real preview visible during the lazy import, then hand over before paint. */
export function usePreviewEditorHandoff(options: {
  client: QueryClient;
  cwd: string | null;
  filePath: string | null;
  contents: string;
  enabled: boolean;
  container: RefObject<HTMLDivElement | null>;
  load: () => Promise<unknown>;
  onEdit: ((filePath: string) => void) | undefined;
}) {
  const current = useRef(options);
  current.current = options;
  const request = useRef<{ cancel(): void } | null>(null);
  const [preparing, setPreparing] = useState(false);
  useLayoutEffect(() => {
    setPreparing(false);
    return () => {
      request.current?.cancel();
      request.current = null;
    };
  }, [options.cwd, options.filePath]);
  useLayoutEffect(() => {
    const { client, cwd, filePath, container, enabled } = options;
    if (!cwd || !filePath || !enabled || !container.current) return;
    const geometry = previewGeometry(container.current);
    if (!geometry) return;
    const view = takeEditorView(client, cwd, filePath, "preview");
    if (!view) return;
    container.current.scrollTop =
      geometry.inset + (view.lineNumber - 1 + view.lineFraction) * geometry.lineHeight;
    container.current.scrollLeft = view.scrollLeft;
    container.current.tabIndex = -1;
    container.current.focus({ preventScroll: true });
  }, [
    options.client,
    options.cwd,
    options.filePath,
    options.contents,
    options.enabled,
    options.container,
  ]);

  const begin = () => {
    if (request.current) {
      request.current.cancel();
      request.current = null;
      setPreparing(false);
      return;
    }
    const initial = current.current;
    if (!initial.cwd || !initial.filePath || !initial.onEdit) return;
    let cancelled = false;
    const selected =
      initial.enabled && initial.container.current
        ? capturePreviewView(initial.container.current)?.selection
        : undefined;
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      request.current = null;
      setPreparing(false);
      const now = current.current;
      if (now.cwd !== initial.cwd || now.filePath !== initial.filePath || !now.onEdit) return;
      const view =
        now.enabled && now.container.current
          ? capturePreviewView(now.container.current)
          : undefined;
      if (view)
        rememberEditorView(now.client, initial.cwd!, initial.filePath!, {
          ...view,
          ...(selected ? { selection: selected } : {}),
        });
      now.onEdit(initial.filePath!);
    };
    // A stalled chunk must not trap navigation. The existing editor boundary
    // retains its loading/error fallback; there is no unsandboxed code path.
    const timer = setTimeout(finish, 10_000);
    request.current = {
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
      },
    };
    setPreparing(true);
    void initial.load().then(finish, finish);
  };
  return { begin, preparing };
}
