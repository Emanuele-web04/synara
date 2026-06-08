// FILE: ChatMarkdown.tsx
// Purpose: Renders assistant and plan markdown with syntax highlighting and local file links.
// Layer: Web chat presentation component
// Exports: ChatMarkdown

import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon, TextWrapIcon } from "~/lib/icons";
import type { ThreadMarker } from "@t3tools/contracts";
import React, {
  Children,
  type CSSProperties,
  Suspense,
  isValidElement,
  use,
  useCallback,
  useDeferredValue,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openInPreferredEditor } from "../editorPreferences";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { dedentCode, parseCodeFenceInfo, type CodeFenceInfo } from "../lib/codeFence";
import { getFileIconName } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { isLocalImageMarkdownSrc } from "../lib/localImageUrls";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { GeneratedMarkdownImage } from "./chat/GeneratedMarkdownImage";
import { IconButton } from "./ui/icon-button";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  markers?: readonly ThreadMarker[] | undefined;
  activeMarkerId?: string | null | undefined;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
type MarkdownRemarkPlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
const MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
];
const LITERAL_DOLLAR_PLACEHOLDER = "\uE000";

function restoreLiteralDollarPlaceholders(value: string): string {
  return value
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(encodeURIComponent(LITERAL_DOLLAR_PLACEHOLDER), "$");
}

function restoreLiteralDollarsInNode(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    node.value = restoreLiteralDollarPlaceholders(node.value);
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      restoreLiteralDollarsInNode(child);
    }
  }
}

function rehypeRestoreLiteralDollars() {
  return (tree: unknown) => {
    restoreLiteralDollarsInNode(tree);
  };
}

const MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  [rehypeKatex, { output: "htmlAndMathml", strict: false, throwOnError: false }],
  rehypeRestoreLiteralDollars,
];
type MarkdownTextNode = {
  type: "text";
  value: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};
type MarkdownParentNode = {
  type?: string;
  children?: MarkdownNode[];
};
type MarkdownNode = MarkdownTextNode | MarkdownParentNode | Record<string, unknown>;
type ActiveThreadMarker = ThreadMarker & { className: string };

function markerClassNameFor(marker: ThreadMarker, activeMarkerId: string | null | undefined) {
  return [
    "thread-marker",
    marker.style === "highlight" ? "thread-marker-highlight" : "thread-marker-underline",
    `thread-marker-${marker.color}`,
    marker.done ? "thread-marker-done" : "",
    marker.id === activeMarkerId ? "thread-marker-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeRenderableMarkers(input: {
  text: string;
  markers: readonly ThreadMarker[] | undefined;
  activeMarkerId: string | null | undefined;
}): ActiveThreadMarker[] {
  const markers = input.markers ?? [];
  const result: ActiveThreadMarker[] = [];
  let previousEnd = -1;
  for (const marker of [...markers].sort((left, right) => left.startOffset - right.startOffset)) {
    if (marker.startOffset < previousEnd) {
      continue;
    }
    if (marker.endOffset <= marker.startOffset || marker.endOffset > input.text.length) {
      continue;
    }
    if (input.text.slice(marker.startOffset, marker.endOffset) !== marker.selectedText) {
      continue;
    }
    result.push({
      ...marker,
      className: markerClassNameFor(marker, input.activeMarkerId),
    });
    previousEnd = marker.endOffset;
  }
  return result;
}

function createThreadMarkerRemarkPlugin(input: {
  text: string;
  markers: readonly ThreadMarker[] | undefined;
  activeMarkerId: string | null | undefined;
}) {
  const markers = normalizeRenderableMarkers(input);
  return () => (tree: MarkdownNode) => {
    if (markers.length === 0) {
      return;
    }
    applyThreadMarkersToNode(tree, markers);
  };
}

function applyThreadMarkersToNode(node: MarkdownNode, markers: readonly ActiveThreadMarker[]) {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }

  const parent = node as MarkdownParentNode;
  parent.children = parent.children?.flatMap((child) => {
    if (child && typeof child === "object" && "type" in child && child.type === "text") {
      return splitTextNodeWithMarkers(child as MarkdownTextNode, markers);
    }
    applyThreadMarkersToNode(child, markers);
    return [child];
  });
}

function splitTextNodeWithMarkers(
  node: MarkdownTextNode,
  markers: readonly ActiveThreadMarker[],
): MarkdownNode[] {
  const startOffset = node.position?.start?.offset;
  const endOffset = node.position?.end?.offset;
  if (startOffset === undefined || endOffset === undefined) {
    return [node];
  }
  const overlappingMarkers = markers.filter(
    (marker) => marker.startOffset < endOffset && marker.endOffset > startOffset,
  );
  if (overlappingMarkers.length === 0) {
    return [node];
  }

  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const marker of overlappingMarkers) {
    const markerStart = Math.max(0, marker.startOffset - startOffset);
    const markerEnd = Math.min(node.value.length, marker.endOffset - startOffset);
    if (markerStart < cursor || markerEnd > node.value.length) {
      continue;
    }
    if (markerStart > cursor) {
      nodes.push({ type: "text", value: node.value.slice(cursor, markerStart) });
    }
    nodes.push({
      type: "threadMarker",
      data: {
        hName: "span",
        hProperties: {
          className: marker.className,
          "data-thread-marker-id": marker.id,
          "data-thread-marker-style": marker.style,
          "data-thread-marker-color": marker.color,
        },
      },
      children: [{ type: "text", value: node.value.slice(markerStart, markerEnd) }],
    });
    cursor = markerEnd;
  }
  if (cursor < node.value.length) {
    nodes.push({ type: "text", value: node.value.slice(cursor) });
  }
  return nodes.length > 0 ? nodes : [node];
}
const INLINE_MATH_HINT_REGEX = /[\\^_=+\-*/<>()[\]{}]/;
const ALL_CAPS_DOLLAR_IDENTIFIER_REGEX = /^[A-Z][A-Z0-9_]{1,31}$/;

function isLineStart(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === "\n";
}

function matchFenceDelimiter(
  value: string,
  index: number,
): { marker: "`" | "~"; length: number } | null {
  if (!isLineStart(value, index)) {
    return null;
  }

  const marker = value[index];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let cursor = index;
  while (value[cursor] === marker) {
    cursor += 1;
  }

  return cursor - index >= 3 ? { marker, length: cursor - index } : null;
}

function findFenceEndIndex(
  value: string,
  index: number,
  marker: "`" | "~",
  length: number,
): number {
  let cursor = value.indexOf("\n", index);
  if (cursor === -1) {
    return value.length;
  }
  cursor += 1;

  while (cursor < value.length) {
    if (isLineStart(value, cursor) && value[cursor] === marker) {
      let markerEnd = cursor;
      while (value[markerEnd] === marker) {
        markerEnd += 1;
      }
      if (markerEnd - cursor >= length) {
        const lineEnd = value.indexOf("\n", markerEnd);
        return lineEnd === -1 ? value.length : lineEnd + 1;
      }
    }

    const nextLine = value.indexOf("\n", cursor);
    if (nextLine === -1) {
      return value.length;
    }
    cursor = nextLine + 1;
  }

  return value.length;
}

function findInlineCodeEndIndex(value: string, index: number, length: number): number {
  let cursor = index + length;
  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let markerEnd = cursor;
    while (value[markerEnd] === "`") {
      markerEnd += 1;
    }

    if (markerEnd - cursor === length) {
      return markerEnd;
    }
    cursor = markerEnd;
  }

  return value.length;
}

function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (ALL_CAPS_DOLLAR_IDENTIFIER_REGEX.test(trimmed)) {
    return false;
  }
  if (INLINE_MATH_HINT_REGEX.test(trimmed)) {
    return true;
  }
  return /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(trimmed);
}

// Reject obvious literal/currency dollars before searching for a closing math delimiter.
function canOpenInlineMath(value: string, index: number): boolean {
  const next = value[index + 1];
  if (!next || /\s|\d/.test(next)) {
    return false;
  }
  return true;
}

// Markdown math delimiters should hug content; loose "$ " endings are treated as prose.
function canCloseInlineMath(value: string, index: number): boolean {
  const previous = value[index - 1];
  if (!previous || /\s/.test(previous)) {
    return false;
  }
  return true;
}

function findInlineMathClosingDollar(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "$") {
      return canCloseInlineMath(value, cursor) ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

function protectLiteralDollarsInPlainText(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += LITERAL_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    if (value.startsWith("$$", cursor)) {
      const closingIndex = value.indexOf("$$", cursor + 2);
      if (closingIndex === -1) {
        result += `${LITERAL_DOLLAR_PLACEHOLDER}${LITERAL_DOLLAR_PLACEHOLDER}`;
        cursor += 2;
        continue;
      }
      result += value.slice(cursor, closingIndex + 2);
      cursor = closingIndex + 2;
      continue;
    }

    if (value[cursor] === "$") {
      if (!canOpenInlineMath(value, cursor)) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const closingIndex = findInlineMathClosingDollar(value, cursor + 1);
      if (closingIndex === -1) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const content = value.slice(cursor + 1, closingIndex);
      result += looksLikeInlineMath(content)
        ? `$${content}$`
        : `${LITERAL_DOLLAR_PLACEHOLDER}${content}${LITERAL_DOLLAR_PLACEHOLDER}`;
      cursor = closingIndex + 1;
      continue;
    }

    result += value[cursor];
    cursor += 1;
  }

  return result;
}

function findMarkdownBracketEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "[") {
      depth += 1;
    } else if (value[cursor] === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findMarkdownParenEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "(") {
      depth += 1;
    } else if (value[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findInlineMarkdownLinkEnd(value: string, index: number): number {
  const bracketStart = value[index] === "!" && value[index + 1] === "[" ? index + 1 : index;
  if (value[bracketStart] !== "[") {
    return -1;
  }

  const bracketEnd = findMarkdownBracketEnd(value, bracketStart);
  if (bracketEnd === -1 || value[bracketEnd + 1] !== "(") {
    return -1;
  }

  const parenEnd = findMarkdownParenEnd(value, bracketEnd + 1);
  return parenEnd === -1 ? -1 : parenEnd + 1;
}

function protectLiteralDollarsInMarkdownLinks(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const isLinkStart =
      value[cursor] === "[" || (value[cursor] === "!" && value[cursor + 1] === "[");
    if (!isLinkStart) {
      const nextLinkStart = value.indexOf("[", cursor);
      const nextImageStart = value.indexOf("![", cursor);
      const candidates = [nextLinkStart, nextImageStart].filter((candidate) => candidate >= 0);
      const nextIndex = candidates.length > 0 ? Math.min(...candidates) : value.length;
      result += protectLiteralDollarsInPlainText(value.slice(cursor, nextIndex));
      cursor = nextIndex;
      continue;
    }

    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd === -1) {
      result += protectLiteralDollarsInPlainText(value[cursor] ?? "");
      cursor += 1;
      continue;
    }

    // Inline links are parsed after math, so protect route params like `_chat.$threadId.tsx`.
    result += value.slice(cursor, linkEnd).replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER);
    cursor = linkEnd;
  }

  return result;
}

// Tighten single-dollar math so currency and escaped dollars stay literal without touching code spans.
function protectLiteralMarkdownDollars(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const fenceDelimiter = matchFenceDelimiter(value, cursor);
    if (fenceDelimiter) {
      const fenceEndIndex = findFenceEndIndex(
        value,
        cursor,
        fenceDelimiter.marker,
        fenceDelimiter.length,
      );
      result += value.slice(cursor, fenceEndIndex);
      cursor = fenceEndIndex;
      continue;
    }

    if (value[cursor] === "`") {
      let markerEnd = cursor;
      while (value[markerEnd] === "`") {
        markerEnd += 1;
      }
      const inlineCodeEndIndex = findInlineCodeEndIndex(value, cursor, markerEnd - cursor);
      result += value.slice(cursor, inlineCodeEndIndex);
      cursor = inlineCodeEndIndex;
      continue;
    }

    let nextCodeIndex = cursor;
    while (nextCodeIndex < value.length) {
      if (value[nextCodeIndex] === "`" || matchFenceDelimiter(value, nextCodeIndex)) {
        break;
      }
      nextCodeIndex += 1;
    }

    result += protectLiteralDollarsInMarkdownLinks(value.slice(cursor, nextCodeIndex));
    cursor = nextCodeIndex;
  }

  return result;
}

// Returns the raw fence info string (the token after ```), e.g. "ts" or the
// Cursor reference form "173:186:packages/shared/src/model.ts". Parsing into a
// highlighter language + file metadata is handled by `parseCodeFenceInfo`.
function extractRawFenceInfo(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function CodeBlockHeaderTitle({ fence }: { fence: CodeFenceInfo }) {
  if (fence.isFileReference && fence.fileName) {
    return (
      <span className="chat-markdown-codeblock__file" title={fence.filePath ?? fence.fileName}>
        <CentralIcon
          name={getFileIconName(fence.filePath ?? fence.fileName)}
          className="chat-markdown-codeblock__file-icon"
        />
        <span className="chat-markdown-codeblock__file-name">{fence.fileName}</span>
        {fence.directory ? (
          <span className="chat-markdown-codeblock__file-dir">{fence.directory}</span>
        ) : null}
        {fence.lineRange ? (
          <span className="chat-markdown-codeblock__file-lines">{fence.lineRange}</span>
        ) : null}
      </span>
    );
  }

  return <span className="chat-markdown-codeblock__lang">{fence.language}</span>;
}

function MarkdownCodeBlock({
  code,
  fence,
  children,
}: {
  code: string;
  fence: CodeFenceInfo;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);
  const toggleWrap = useCallback(() => setWrap((previous) => !previous), []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            label={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            aria-pressed={wrap}
            data-active={wrap ? "true" : "false"}
            size="icon-xs"
            variant="ghost"
          >
            <TextWrapIcon className="size-3" />
          </IconButton>
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy code"}
            label={copied ? "Copied" : "Copy code"}
            size="icon-xs"
            variant="ghost"
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </IconButton>
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">{children}</div>
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  language: string;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  language,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  className = "text-sm leading-relaxed",
  style,
  onImageExpand,
  markers,
  activeMarkerId,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const normalizedText = useMemo(() => protectLiteralMarkdownDollars(text), [text]);
  // While streaming, let React deprioritize and coalesce the markdown re-parse so a
  // fast token stream (one flush per ~100ms) doesn't re-render the full ReactMarkdown
  // tree on every flush. The deferred value always converges to the latest text, and
  // completed messages render the exact current text immediately (no visual change).
  const deferredNormalizedText = useDeferredValue(normalizedText);
  const renderedText = isStreaming ? deferredNormalizedText : normalizedText;
  const threadMarkerRemarkPlugin = useMemo(
    () => createThreadMarkerRemarkPlugin({ text, markers, activeMarkerId }),
    [activeMarkerId, markers, text],
  );
  const remarkPlugins = useMemo<MarkdownRemarkPlugins>(
    () =>
      markers && markers.length > 0
        ? [...MARKDOWN_REMARK_PLUGINS, threadMarkerRemarkPlugin]
        : MARKDOWN_REMARK_PLUGINS,
    [markers, threadMarkerRemarkPlugin],
  );
  const markdownUrlTransform = useCallback((href: string) => {
    const restoredHref = restoreLiteralDollarPlaceholders(href);
    return rewriteMarkdownFileUriHref(restoredHref) ?? defaultUrlTransform(restoredHref);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const restoredHref = href ? restoreLiteralDollarPlaceholders(href) : href;
        const targetPath = resolveMarkdownFileLinkTarget(restoredHref, cwd);
        if (!targetPath) {
          return <a {...props} href={restoredHref} target="_blank" rel="noopener noreferrer" />;
        }

        return (
          <a
            {...props}
            href={restoredHref}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const api = readNativeApi();
              if (api) {
                void openInPreferredEditor(api, targetPath);
              } else {
                console.warn("Native API not found. Unable to open file in editor.");
              }
            }}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const fence = parseCodeFenceInfo(extractRawFenceInfo(codeBlock.className));
        const code = dedentCode(codeBlock.code);

        return (
          <MarkdownCodeBlock code={code} fence={fence}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  language={fence.language}
                  code={code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
      img({ node: _node, src, alt = "", ...props }) {
        const restoredSrc = src ? restoreLiteralDollarPlaceholders(src) : "";
        if (isLocalImageMarkdownSrc(restoredSrc)) {
          return (
            <GeneratedMarkdownImage
              src={restoredSrc}
              alt={alt}
              cwd={cwd}
              onImageExpand={onImageExpand}
            />
          );
        }
        return <img {...props} src={restoredSrc} alt={alt} loading="lazy" />;
      },
    }),
    [cwd, diffThemeName, isStreaming, onImageExpand],
  );

  return (
    <div className={`chat-markdown w-full min-w-0 ${className} text-foreground`} style={style}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {renderedText}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
