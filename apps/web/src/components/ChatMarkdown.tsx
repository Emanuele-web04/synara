// FILE: ChatMarkdown.tsx
// Purpose: Renders assistant and plan markdown with syntax highlighting and local file links.
// Layer: Web chat presentation component
// Exports: ChatMarkdown

import {
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  OctagonAlertIcon,
  TextWrapIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "~/lib/icons";
import {
  INLINE_VISUAL_EMBED_FENCE,
  ThreadId,
  type ProviderMentionReference,
} from "@synara/contracts";
import { isLocalAbsolutePath } from "@synara/shared/path";
import type { ChatAttachment } from "~/types";
import { matchWikiLinkAt, remarkWikiLinks } from "../lib/remarkWikiLinks";
import { remarkGithubAlerts, type GithubAlertKind } from "../lib/remarkGithubAlerts";
import { remarkHtmlBreaks } from "../lib/remarkHtmlBreaks";
import { MARKDOWN_IMAGE_ROW_CLASS_NAME, remarkImageRows } from "../lib/remarkImageRows";
import React, {
  Children,
  createContext,
  useContext,
  type CSSProperties,
  Suspense,
  isValidElement,
  memo,
  use,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffTheme";
import { LRUCache } from "../lib/lruCache";
import { dedentCode, parseCodeFenceInfo, type CodeFenceInfo } from "../lib/codeFence";
import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlightingLimits";
import { getFileIconName, pathLooksLikeKnownFile } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import {
  isLocalImageMarkdownSrc,
  isLocalVideoMarkdownSrc,
  normalizeMarkdownImagePath,
} from "../lib/localImageUrls";
import { repairMarkdownTableDelimiters } from "../lib/markdownTableRepair";
import { resolveMarkdownTextDirection, scriptDirection } from "../lib/markdownDirection";
import { extractTableMarkdown, rehypeTableLayout } from "../lib/markdownTableLayout";
import { showFileReferenceContextMenu } from "../lib/fileReferenceContextMenu";
import {
  ChatLinkActionsContext,
  resolveGitHubItemClickOpener,
  showLinkContextMenu,
} from "../lib/linkContextMenu";
import { useTheme } from "../hooks/useTheme";
import { useSmoothStreamedText } from "../hooks/useSmoothStreamedText";
import { useStableCallback } from "../hooks/useStableCallback";
import { useStableValue } from "../hooks/useStableValue";
import { useThrottledStreamingValue } from "../hooks/useThrottledStreamingValue";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../lib/workspaceFileOpener";
import { useQuery } from "@tanstack/react-query";
import { projectResolveWorkspaceFileReferenceQueryOptions } from "../lib/projectReactQuery";
import {
  extractAbsoluteFilesystemPaths,
  resolveChatFileChipTarget,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { GeneratedMarkdownImage } from "./chat/GeneratedMarkdownImage";
import { GeneratedMarkdownVideo } from "./chat/GeneratedMarkdownVideo";
import { TerminalContextInlineChip } from "./chat/TerminalContextInlineChip";
import type { ParsedTerminalContextEntry } from "../lib/terminalContext";
import { formatInlineTerminalContextLabel } from "./chat/userMessageTerminalContexts";
import {
  COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
} from "./composerInlineChip";
import { LinkChipIcon } from "./LinkChipIcon";
import { InlineAgentChip } from "./chat/InlineAgentChip";
import { readInlineVisualEmbedId } from "@synara/shared/inlineVisual";
import { InlineVisualEmbedContext } from "./chat/inlineVisualEmbedContext";
import { InlineLinkChip } from "./InlineLinkChip";
import { InlineMentionChip } from "./chat/InlineMentionChip";
import { InlineSkillChip } from "./chat/InlineSkillChip";
import { InlineSlashCommandChip } from "./chat/InlineSlashCommandChip";
import {
  COMPOSER_CHIP_SEGMENT_ATTRIBUTE,
  COMPOSER_CHIP_TAG_NAME,
  TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE,
  TERMINAL_CONTEXT_CHIP_TAG_NAME,
  createComposerChipsRemarkPlugin,
  parseComposerChipSegment,
} from "../lib/remarkComposerChips";
import { IconButton } from "./ui/icon-button";
import {
  applyActiveChatFindMatch,
  normalizeFindQuery,
  type ThreadFindRange,
} from "./chat/threadFind.logic";
import {
  useStreamingMarkdownChildren,
  type StreamingMarkdownBlock,
} from "./chat/streamingMarkdownBlocks";
import {
  ChatFindRenderProvider,
  FindAwareCodeFallback,
  FindAwareMarkdownText,
  FindAwareShikiHtml,
} from "./ChatMarkdownFind";
import { useTranslation } from "~/i18n";

const EXTERNAL_HTTP_HREF_PATTERN = /^https?:\/\//i;
// Trailing `:line` / `:line:col` position suffix on a resolved file link. Kept on
// the href (so opening jumps to the line) but stripped for icon/title resolution.
const MARKDOWN_LINK_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const MARKDOWN_EXTERNAL_LINK_CLASS_NAME =
  "inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline";
const MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME = `${COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME} ${COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME}`;

function isExternalHttpHref(href: string | undefined): href is string {
  return typeof href === "string" && EXTERNAL_HTTP_HREF_PATTERN.test(href);
}

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
  threadId?: string | null | undefined;
  /** Attachments belong only to this message; source aliases never cross transcript rows. */
  imageAttachments?: ReadonlyArray<ChatAttachment> | undefined;
  wikiLinkRoot?: string | undefined;
  /**
   * Opts a transcript message into direction detection. The message takes a base
   * direction from its dominant script, and every prose block overrides it from
   * its own dominant script (see `markdownDirection`), so a Persian reply stays
   * RTL even when a paragraph opens with a Latin name or a code chip, and an
   * English paragraph in the same reply stays LTR. The default keeps the shared
   * renderer's existing direction behavior for previews, plans, and other
   * non-transcript consumers.
   */
  directionMode?: "off" | "auto-blocks";
  isStreaming?: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  onImageExpand?:
    | ((preview: ExpandedImagePreview, sourceImage?: HTMLImageElement) => void)
    | undefined;
  /** Case-insensitive substring to wrap while in-thread find is open. */
  findQuery?: string | undefined;
  /** Active occurrence in this markdown body; other hits stay dimmer. */
  findActiveRange?: ThreadFindRange | null | undefined;
  /**
   * "user" renders a sent prompt: GFM plus hard line breaks (single newlines
   * survive the way they were typed), no math/KaTeX and no literal-dollar
   * rewriting (`$50` and `$skill` stay verbatim), and composer inline tokens
   * (skills, mentions, agents, bare links) render as the shared chips.
   */
  variant?: "assistant" | "user";
  /** Mention metadata for chip icon resolution; only used by the user variant. */
  mentionReferences?: ReadonlyArray<ProviderMentionReference> | undefined;
  /**
   * Parses and sanitizes authored HTML embedded in the markdown. Keep this
   * disabled for provider/user content, which must continue to render HTML as
   * text.
   */
  parseHtml?: boolean | undefined;
  /**
   * Shares the parsed tree of this settled text with every other mount of the same
   * text (see `parsedMarkdownCache`). Only for transcript rows, whose settled text is
   * immutable and remounts as the list scrolls.
   */
  shareParse?: boolean | undefined;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** Terminal selections rendered as inline chips inside user-message markdown. */
  terminalContexts?: ReadonlyArray<ParsedTerminalContextEntry> | undefined;
  /**
   * Makes GFM task-list checkboxes interactive. Receives the 1-based line of
   * the task item in `text` so the caller can flip that `[ ]` marker at the
   * source (line numbers stay valid because the internal dollar protection is
   * length- and newline-preserving). Without it checkboxes render read-only.
   */
  onTaskToggle?: ((input: { sourceLine: number; checked: boolean }) => void) | undefined;
  /**
   * Absolute paths already observed on this turn's tool calls. A relative
   * inline-code chip uses one of these when the match is unique.
   */
  knownAbsoluteFilePaths?: ReadonlyArray<string> | undefined;
}

// Source line of the enclosing task-list item, provided by the `li` override.
// The checkbox `input` element is synthesized by mdast-util-to-hast without
// position info, so it cannot read its own source location.
const TaskItemSourceLineContext = React.createContext<number | null>(null);

function MarkdownTaskCheckbox(props: {
  checked: boolean;
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
}) {
  const { checked, onTaskToggle } = props;
  const sourceLine = React.useContext(TaskItemSourceLineContext);
  const interactive = onTaskToggle !== undefined && sourceLine !== null;
  return (
    <input
      type="checkbox"
      className="chat-markdown-task-checkbox"
      checked={checked}
      disabled={!interactive}
      {...(interactive ? { onChange: () => onTaskToggle({ sourceLine, checked: !checked }) } : {})}
    />
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
type MarkdownRemarkPlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
interface ParsedMarkdownProps {
  text: string;
  /**
   * Parses settled top-level blocks once and re-parses only the growing tail
   * (see streamingMarkdownBlocks). The flattened output matches a single parse
   * of `text` element for element, keys included, so turning this off when a
   * stream ends updates the same DOM nodes in place.
   */
  splitBlocks: boolean;
  remarkPlugins: MarkdownRemarkPlugins;
  rehypePlugins: MarkdownRehypePlugins;
  components: Components;
  /**
   * Everything besides the text that shapes the parse output, when the parse may be
   * shared through `parsedMarkdownCache`; null for streaming or per-message plugins.
   */
  parseCacheScope: string | null;
}

// Parsed element trees of settled transcript messages, keyed by parse scope and source
// text. A virtualized transcript unmounts rows that scroll away and remounts them on the
// way back, which re-ran the whole unified pipeline for every remount. Element trees are
// immutable and every render-time input (theme, find highlights, file chips, links) is
// read from context by the markdown components, so one tree serves every mount of the
// same text.
//
// Sharing is opt-in (`shareParse`): only transcript rows remount the same settled text.
// Other surfaces (file previews, PR bodies, dialogs) render text that changes while it
// is shown or can be very large, and would only fill the cache with dead versions.
// Measured retained size: ~13.5 bytes per source character (10.4 MB for the 770 KB of
// a fully read 300-message prose thread); 14 is used. One entry may not exceed
// `PARSED_MARKDOWN_CACHE_MAX_SOURCE_CHARS`: the LRU admits an entry larger than its
// whole budget by evicting everything else, so a huge message would flush the cache.
const PARSED_MARKDOWN_CACHE_MAX_ENTRIES = 600;
const PARSED_MARKDOWN_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const PARSED_MARKDOWN_BYTES_PER_SOURCE_CHAR = 14;
const PARSED_MARKDOWN_CACHE_MAX_SOURCE_CHARS = 64 * 1024;
const parsedMarkdownCache = new LRUCache<readonly ReactNode[]>(
  PARSED_MARKDOWN_CACHE_MAX_ENTRIES,
  PARSED_MARKDOWN_CACHE_MAX_BYTES,
);

export function getSharedParseCacheSizeForTests(): number {
  return parsedMarkdownCache.size;
}

// react-markdown's `Markdown` is synchronous and hook-free, so calling it as a
// function yields exactly the element tree it renders as a component.
const renderMarkdownToElements = ReactMarkdown;

function markdownRootChildren(root: ReactNode): readonly ReactNode[] {
  if (
    isValidElement<{ children?: ReactNode }>(root) &&
    root.type === React.Fragment &&
    root.key === null
  ) {
    const children = root.props.children;
    if (Array.isArray(children)) return children;
    return children === undefined || children === null ? [] : [children];
  }
  return root === undefined || root === null ? [] : [root];
}

interface MarkdownParseOptions {
  readonly remarkPlugins: MarkdownRemarkPlugins;
  readonly rehypePlugins: MarkdownRehypePlugins;
  readonly components: Components;
  readonly parseCacheScope: string | null;
}

function parseMarkdownBlock(
  block: StreamingMarkdownBlock,
  options: MarkdownParseOptions,
): readonly ReactNode[] {
  // Only a whole-message parse (offset 0, not split for streaming) is shared.
  if (
    options.parseCacheScope === null ||
    block.offset !== 0 ||
    block.text.length > PARSED_MARKDOWN_CACHE_MAX_SOURCE_CHARS
  ) {
    return parseMarkdownBlockUncached(block, options);
  }
  const cacheKey = `${options.parseCacheScope}\u0000${block.text}`;
  const cached = parsedMarkdownCache.get(cacheKey);
  if (cached !== null) return cached;
  const children = parseMarkdownBlockUncached(block, options);
  parsedMarkdownCache.set(
    cacheKey,
    children,
    block.text.length * PARSED_MARKDOWN_BYTES_PER_SOURCE_CHAR,
  );
  return children;
}

function parseMarkdownBlockUncached(
  block: StreamingMarkdownBlock,
  options: MarkdownParseOptions,
): readonly ReactNode[] {
  return markdownRootChildren(
    renderMarkdownToElements({
      children: block.text,
      remarkPlugins:
        block.offset === 0
          ? options.remarkPlugins
          : withSourcePositionOffset(options.remarkPlugins, block),
      rehypePlugins: options.rehypePlugins,
      components: options.components,
      urlTransform: markdownUrlTransform,
    }),
  );
}

const ParsedMarkdown = memo(function ParsedMarkdown({
  text,
  splitBlocks,
  remarkPlugins,
  rehypePlugins,
  components,
  parseCacheScope,
}: ParsedMarkdownProps) {
  const children = useStreamingMarkdownChildren(
    text,
    splitBlocks,
    {
      remarkPlugins,
      rehypePlugins,
      components,
      parseCacheScope: splitBlocks ? null : parseCacheScope,
    },
    parseMarkdownBlock,
  );
  return <>{children}</>;
});

const CHAT_FIND_TEXT_TAG_NAME = "chat-find-text";
const CHAT_FIND_TEXT_START_ATTRIBUTE = "data-chat-find-text-start";

// Lazy-load KaTeX (~280 KB JS + 28 KB CSS + fonts) and authored-HTML plugins
// (`rehype-raw` + `rehype-sanitize`) in production so the default chat chunk
// avoids downloading and parsing them until a message actually uses math (`$`)
// or authored HTML preview (`parseHtml`). In test mode, keep them loaded upfront
// so synchronous unit/browser assertions stay deterministic.
type MathPluginsBundle = {
  readonly remarkMath: MarkdownRemarkPlugins[number];
  readonly rehypeKatex: MarkdownRehypePlugins[number];
};
type AuthoredHtmlPluginsBundle = {
  readonly plugins: MarkdownRehypePlugins;
};

let cachedMathPlugins: MathPluginsBundle | null = null;
let mathPluginsPromise: Promise<MathPluginsBundle> | null = null;
let cachedAuthoredHtmlPlugins: AuthoredHtmlPluginsBundle | null = null;
let authoredHtmlPluginsPromise: Promise<AuthoredHtmlPluginsBundle> | null = null;

type RehypeSanitizeSchema = (typeof import("rehype-sanitize"))["defaultSchema"];

function buildAuthoredHtmlPlugins(
  rehypeRawPlugin: unknown,
  rehypeSanitizePlugin: unknown,
  baseSchema: RehypeSanitizeSchema,
): AuthoredHtmlPluginsBundle {
  // Keep the renderer's generated metadata through the authored-HTML sanitizer.
  // KaTeX runs afterward so its generated MathML/styles do not widen this allowlist.
  const authoredHtmlSchema = {
    ...baseSchema,
    tagNames: [...(baseSchema.tagNames ?? []), CHAT_FIND_TEXT_TAG_NAME],
    attributes: {
      ...baseSchema.attributes,
      [CHAT_FIND_TEXT_TAG_NAME]: ["dataChatFindTextStart"],
      blockquote: [
        ...(baseSchema.attributes?.blockquote ?? []),
        ["dataGithubAlert", "note", "tip", "important", "warning", "caution"],
      ],
      span: [...(baseSchema.attributes?.span ?? []), ["className", MARKDOWN_IMAGE_ROW_CLASS_NAME]],
    },
    protocols: {
      ...baseSchema.protocols,
      href: [...(baseSchema.protocols?.href ?? []), "file", "thread", "synara"],
    },
  };
  return {
    plugins: [
      rehypeRawPlugin as MarkdownRehypePlugins[number],
      [rehypeSanitizePlugin, authoredHtmlSchema] as MarkdownRehypePlugins[number],
    ],
  };
}

function loadMathPlugins(): Promise<MathPluginsBundle> {
  if (cachedMathPlugins) return Promise.resolve(cachedMathPlugins);
  if (!mathPluginsPromise) {
    mathPluginsPromise = Promise.all([
      import("remark-math"),
      import("rehype-katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([remarkMathMod, rehypeKatexMod]) => {
      cachedMathPlugins = {
        remarkMath: [remarkMathMod.default, { singleDollarTextMath: true }],
        rehypeKatex: [
          rehypeKatexMod.default,
          { output: "htmlAndMathml", strict: false, throwOnError: false },
        ],
      };
      return cachedMathPlugins;
    });
  }
  return mathPluginsPromise;
}

function loadAuthoredHtmlPlugins(): Promise<AuthoredHtmlPluginsBundle> {
  if (cachedAuthoredHtmlPlugins) return Promise.resolve(cachedAuthoredHtmlPlugins);
  if (!authoredHtmlPluginsPromise) {
    authoredHtmlPluginsPromise = Promise.all([
      import("rehype-raw"),
      import("rehype-sanitize"),
    ]).then(([rehypeRawMod, rehypeSanitizeMod]) => {
      cachedAuthoredHtmlPlugins = buildAuthoredHtmlPlugins(
        rehypeRawMod.default,
        rehypeSanitizeMod.default,
        rehypeSanitizeMod.defaultSchema,
      );
      return cachedAuthoredHtmlPlugins;
    });
  }
  return authoredHtmlPluginsPromise;
}

if (import.meta.env.MODE === "test") {
  await Promise.all([loadMathPlugins(), loadAuthoredHtmlPlugins()]);
}

const BASE_MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  remarkGithubAlerts,
  remarkHtmlBreaks,
  remarkImageRows,
];
// User prompts are casual typing, not authored markdown: hard-break single
// newlines and skip math entirely (the composer chip plugin is appended per
// render because it closes over the message's mention references).
const USER_MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [remarkGfm, remarkBreaks];
const USER_MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [rehypeTableLayout];
const LITERAL_DOLLAR_PLACEHOLDER = "\uE000";
// `\$` is two source characters that render as a single `$`. Collapsing it to one placeholder used
// to shorten the protected string, which shifted every downstream source offset (find positions
// are resolved against the raw text but applied against the parsed mdast positions). A two-character
// placeholder keeps `protectLiteralMarkdownDollars` length-preserving so those offsets stay aligned;
// it is restored ahead of the single-char placeholder (the two share no characters, so order is
// only for clarity).
const ESCAPED_DOLLAR_PLACEHOLDER = "\uE001\uE002";

function restoreLiteralDollarPlaceholders(value: string): string {
  return value
    .replaceAll(ESCAPED_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(encodeURIComponent(ESCAPED_DOLLAR_PLACEHOLDER), "$")
    .replaceAll(encodeURIComponent(LITERAL_DOLLAR_PLACEHOLDER), "$");
}

// synara://thread/<target> links carry an id or title that may be
// %-encoded; a malformed sequence keeps the raw target instead of throwing.
function decodeSynaraThreadLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target).trim();
  } catch {
    return target.trim();
  }
}

function markdownUrlTransform(href: string): string {
  const restoredHref = restoreLiteralDollarPlaceholders(href);
  if (restoredHref.startsWith("thread://") || restoredHref.startsWith("synara://thread/")) {
    return restoredHref;
  }
  return rewriteMarkdownFileUriHref(restoredHref) ?? defaultUrlTransform(restoredHref);
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

const BASE_MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  // Classify literal dollars while leaving the math nodes and source offsets for KaTeX.
  [rehypeTableLayout, restoreLiteralDollarPlaceholders],
  rehypeRestoreLiteralDollars,
];

type BidiHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  value?: string;
  children?: BidiHastNode[];
};

const BIDI_OWNER_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "th", "td"]);
const BIDI_CONTAINER_TAGS = new Set(["ul", "ol", "blockquote"]);
const BIDI_OPAQUE_TAGS = new Set(["pre", "code", "script", "style"]);

function isBidiOpaque(node: BidiHastNode): boolean {
  if (!node.tagName) return false;
  if (BIDI_OPAQUE_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  return className === "katex" || (Array.isArray(className) && className.includes("katex"));
}

function ownsItsDirection(node: BidiHastNode): boolean {
  return Boolean(
    node.tagName &&
    (BIDI_OWNER_TAGS.has(node.tagName) ||
      BIDI_CONTAINER_TAGS.has(node.tagName) ||
      node.tagName === "table"),
  );
}

/** GFM links named after their address carry no additional prose. */
function isAutomaticBidiLink(node: BidiHastNode): boolean {
  const href = node.properties?.href;
  if (node.tagName !== "a" || typeof href !== "string" || node.children?.length !== 1) {
    return false;
  }
  let labelNode = node.children[0];
  // Transcript search wraps plain labels in a source-position node.
  if (labelNode?.tagName === CHAT_FIND_TEXT_TAG_NAME && labelNode.children?.length === 1) {
    labelNode = labelNode.children[0];
  }
  const label = labelNode?.type === "text" ? labelNode.value : undefined;
  if (!label) return false;
  return (
    (href === label && /^[a-z][a-z0-9+.-]*:\/\//i.test(label)) ||
    (/^www\./i.test(label) && href === `http://${label}`) ||
    href === `mailto:${label}`
  );
}

/**
 * Collects a block's own prose, joined with spaces so identifiers that sit in
 * separate inline nodes stay separate words. Nested blocks (a list inside a list
 * item, a paragraph inside a quote) resolve their own direction, so they are
 * skipped, as are code, math, and other non-prose runs.
 */
function collectBlockText(node: BidiHastNode): string {
  const parts: string[] = [];

  const walk = (child: BidiHastNode) => {
    if (child.type === "text") {
      parts.push(child.value ?? "");
      return;
    }
    if (isBidiOpaque(child) || ownsItsDirection(child) || isAutomaticBidiLink(child)) return;
    for (const grandchild of child.children ?? []) walk(grandchild);
  };

  for (const child of node.children ?? []) walk(child);
  return parts.join(" ");
}

function majorityDirection(directions: ReadonlyArray<"rtl" | "ltr">): "rtl" | "ltr" | undefined {
  let rtl = 0;
  let ltr = 0;
  for (const direction of directions) {
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl + ltr === 0) return undefined;
  return rtl > ltr ? "rtl" : "ltr";
}

function setBidiDirection(node: BidiHastNode, direction: "rtl" | "ltr"): void {
  node.properties = { ...node.properties, dir: direction };
}

function resolveBidiDirections(node: BidiHastNode): "rtl" | "ltr" | undefined {
  if (node.type === "text" || isBidiOpaque(node)) return undefined;

  const childDirections: Array<"rtl" | "ltr"> = [];
  for (const child of node.children ?? []) {
    const direction = resolveBidiDirections(child);
    if (direction) childDirections.push(direction);
  }

  if (node.type !== "element" || !node.tagName) {
    return majorityDirection(childDirections);
  }
  if (BIDI_OWNER_TAGS.has(node.tagName)) {
    // Loose list items and table cells hold nested paragraphs; when they carry no
    // inline text of their own, follow the blocks they contain.
    const direction =
      scriptDirection(collectBlockText(node)) ?? majorityDirection(childDirections) ?? undefined;
    if (direction) setBidiDirection(node, direction);
    return direction;
  }
  if (BIDI_CONTAINER_TAGS.has(node.tagName)) {
    const direction = majorityDirection(childDirections);
    if (direction) setBidiDirection(node, direction);
    return direction;
  }
  return undefined;
}

/**
 * Gives every prose block its own direction from the dominant script of that
 * block. First-strong (`dir="auto"`) is not enough in technical Persian: a
 * paragraph that opens with `netkeep`, `**Stripe، Linear:**`, or `*.github.com`
 * would otherwise be laid out in logical LTR order. Containers follow the
 * majority of their items so list markers, gutters, and quote borders stay on
 * the same side as the text they decorate.
 */
function rehypeBidiBlockDirection() {
  return (tree: BidiHastNode) => {
    resolveBidiDirections(tree);
  };
}

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
function remarkFindableText() {
  return (tree: MarkdownNode) => wrapFindableTextNodes(tree);
}

function wrapFindableTextNodes(node: MarkdownNode): void {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }
  const parent = node as MarkdownParentNode;
  parent.children = (parent.children ?? []).map((child) => {
    if (child && typeof child === "object" && "type" in child && child.type === "text") {
      return wrapFindableTextNode(child as MarkdownTextNode);
    }
    wrapFindableTextNodes(child);
    return child;
  });
}

function wrapFindableTextNode(node: MarkdownTextNode): MarkdownNode {
  const startOffset = node.position?.start?.offset;
  if (startOffset === undefined || node.value.length === 0) {
    return node;
  }
  return {
    type: "chatFindText",
    data: {
      hName: CHAT_FIND_TEXT_TAG_NAME,
      hProperties: { [CHAT_FIND_TEXT_START_ATTRIBUTE]: String(startOffset) },
    },
    children: [node],
  };
}

type SourcePoint = { line: number; column: number; offset?: number | undefined };
type SourcePositionedNode = {
  position?: { start: SourcePoint; end: SourcePoint } | undefined;
  children?: SourcePositionedNode[];
};

/**
 * Moves the mdast positions of a block parsed on its own to where the block
 * sits in the whole message, so find offsets, code source offsets and task
 * line numbers match a single parse. Runs after the plugins that slice the
 * block's own source by offset (alerts, wiki links) and before
 * `remarkFindableText`. Plugins may share point objects between nodes, so
 * points are replaced, never mutated.
 */
function remarkSourcePositionOffset(options: { offset: number; lineOffset: number }) {
  const shiftPoint = (point: SourcePoint): SourcePoint => ({
    ...point,
    line: point.line + options.lineOffset,
    ...(point.offset === undefined ? {} : { offset: point.offset + options.offset }),
  });
  const shiftNode = (node: SourcePositionedNode): void => {
    if (node.position) {
      node.position = {
        ...node.position,
        start: shiftPoint(node.position.start),
        end: shiftPoint(node.position.end),
      };
    }
    for (const child of node.children ?? []) shiftNode(child);
  };
  return (tree: SourcePositionedNode) => shiftNode(tree);
}

function withSourcePositionOffset(
  plugins: MarkdownRemarkPlugins,
  block: StreamingMarkdownBlock,
): MarkdownRemarkPlugins {
  const offsetPlugin: MarkdownRemarkPlugins[number] = [
    remarkSourcePositionOffset,
    { offset: block.offset, lineOffset: block.line - 1 },
  ];
  const findableIndex = plugins.indexOf(remarkFindableText);
  return findableIndex < 0
    ? [...plugins, offsetPlugin]
    : [...plugins.slice(0, findableIndex), offsetPlugin, ...plugins.slice(findableIndex)];
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

  return -1;
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
  return /^(?:\d+(?:\.\d+)?)?[A-Za-z][A-Za-z0-9]{0,15}$/.test(trimmed);
}

// Reject obvious literal/currency dollars before searching for a closing math delimiter.
function canOpenInlineMath(value: string, index: number): boolean {
  const next = value[index + 1];
  if (!next || /\s/.test(next)) {
    return false;
  }
  if (/\d/.test(next)) {
    const closingIndex = findInlineMathClosingDollar(value, index + 1);
    if (closingIndex === -1 || /\d/.test(value[closingIndex + 1] ?? "")) {
      return false;
    }
    // A numeric prefix can be a coefficient. Require a complete expression
    // on this line; do not pair prices across lines or consume `$5-$10`.
    const content = value.slice(index + 1, closingIndex);
    return !/[\r\n]/.test(content) && looksLikeInlineMath(content);
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
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd !== -1) {
      // Dollars in Markdown links/images cannot close preceding literal text.
      // Dollar-free [f](x) remains valid inside a TeX expression.
      if (value.slice(cursor, linkEnd).includes("$")) {
        return -1;
      }
      cursor = linkEnd;
      continue;
    }
    if (value[cursor] === "$") {
      return canCloseInlineMath(value, cursor) ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

function protectLiteralDollarsInMarkdownLinks(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += ESCAPED_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    // Scan links and math together: splitting at every `[` breaks TeX such as
    // \left[...\right] before its closing dollars can be found. A math span is
    // consumed whole below, so brackets inside it never enter link detection.
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd !== -1) {
      result += value.slice(cursor, linkEnd).replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER);
      cursor = linkEnd;
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
  const wikiLink = matchWikiLinkAt(value, index);
  if (wikiLink) return index + wikiLink[0].length;
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

// Tighten single-dollar math so currency and escaped dollars stay literal without touching code spans.
function protectLiteralMarkdownDollars(value: string): {
  readonly text: string;
  readonly hasMath: boolean;
} {
  let result = "";
  let hasMath = false;
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
      if (inlineCodeEndIndex === -1) {
        // An unmatched backtick is ordinary Markdown text. Preserve the raw
        // tail and let remark-math interpret any delimiters there.
        const remainder = value.slice(cursor);
        return { text: result + remainder, hasMath: hasMath || remainder.includes("$") };
      }
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

    const prose = protectLiteralDollarsInMarkdownLinks(value.slice(cursor, nextCodeIndex));
    hasMath ||= prose.includes("$");
    result += prose;
    cursor = nextCodeIndex;
  }

  return { text: result, hasMath };
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

  // The single child is the fenced code element. Its rendered `type` is the
  // custom `code` component (not the string "code") once we override `code`
  // below, so detect by shape (a valid element carrying the code text) rather
  // than by tag identity. `pre` only ever wraps a code element in markdown.
  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

const INLINE_CODE_FILE_PATH_MAX_LENGTH = 120;

// Decides whether an inline code span names a file/path that should render as a
// mention chip (icon + medium label), matching how a file reads in the composer.
// Conservative on purpose: requires a recognized filename/extension and rejects
// whitespace and URLs so ordinary prose tokens stay plain inline code.
function inlineCodeFilePath(raw: string): string | null {
  // Strip a pair of surrounding quotes/backticks the author may have wrapped the
  // path in (e.g. `'src/data/social-metrics.ts'`).
  const value = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (value.length === 0 || /\s/.test(value) || value.includes("://")) {
    return null;
  }
  const withoutPosition = value.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  // Absolute local files and directories (`/Users/…/annotate-pr`) are chips
  // even without a known filename extension. Relative names still need a
  // recognizable file so ordinary tokens stay code.
  if (resolveMarkdownFileLinkTarget(withoutPosition)) {
    return value;
  }
  if (withoutPosition.length > INLINE_CODE_FILE_PATH_MAX_LENGTH) {
    return null;
  }
  return pathLooksLikeKnownFile(withoutPosition) ? value : null;
}

function VerifiedWorkspaceFileChip(props: {
  rawReference: string;
  cwd: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const relativePath = props.rawReference.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const query = useQuery(
    projectResolveWorkspaceFileReferenceQueryOptions({
      cwd: props.cwd,
      relativePath,
    }),
  );
  const fallback = <code>{props.label ?? relativePath}</code>;
  if (query.isPending || query.isError || query.data === undefined) {
    return fallback;
  }
  if (query.data === null) {
    return fallback;
  }
  return (
    <OpenableFileChip
      targetPath={query.data}
      theme={props.theme}
      {...(props.label !== undefined ? { label: props.label } : {})}
      {...(props.href ? { href: props.href } : {})}
    />
  );
}

// Shared openable file chip: the same mention-chip UI (file icon + medium label)
// used for both assistant markdown file links and inline code that names a file.
// A plain click prefers the surface's in-app viewer (right-dock file pane);
// meta/ctrl-click — or a surface without a viewer — opens the preferred
// external editor. `targetPath` may carry a `:line` suffix (used to open); the
// chip icon and title use the position-free path.
function OpenableFileChip(props: {
  targetPath: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const opener = useWorkspaceFileOpener();
  const chipPath = props.targetPath.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const revealPath = isLocalAbsolutePath(chipPath) ? chipPath : undefined;
  return (
    <InlineMentionChip
      path={chipPath}
      theme={props.theme}
      href={props.href ?? props.targetPath}
      onActivate={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const forceExternalEditor = event.metaKey || event.ctrlKey;
        openWorkspaceFileReference(forceExternalEditor ? null : opener, props.targetPath);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void showFileReferenceContextMenu({
          path: chipPath,
          ...(revealPath ? { revealPath } : {}),
          position: { x: event.clientX, y: event.clientY },
          onReferenceInChat: undefined,
        });
      }}
      {...(opener?.prefetchFile
        ? { onHoverPrefetch: () => opener.prefetchFile?.(props.targetPath) }
        : {})}
      {...(props.label !== undefined ? { label: props.label } : {})}
    />
  );
}

// Renders the custom element emitted by the composer-chips remark plugin with the
// shared chip components, so chips in a sent message match the composer exactly.
function ComposerChipElement(props: {
  serializedSegment: string | undefined;
  theme: "light" | "dark";
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
}) {
  const segment = parseComposerChipSegment(props.serializedSegment);
  if (!segment) {
    return null;
  }
  if (segment.type === "skill") {
    return <InlineSkillChip skillName={segment.name} />;
  }
  if (segment.type === "mention") {
    return (
      <InlineMentionChip
        path={segment.path}
        theme={props.theme}
        mentionReferences={props.mentionReferences}
        {...(segment.kind ? { kind: segment.kind } : {})}
      />
    );
  }
  if (segment.type === "agent-mention") {
    return <InlineAgentChip alias={segment.alias} color={segment.color} />;
  }
  if (segment.type === "slash-command") {
    return <InlineSlashCommandChip command={segment.command} />;
  }
  return <InlineLinkChip url={segment.url} interactive />;
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
  direction,
}: {
  code: string;
  fence: CodeFenceInfo;
  children: ReactNode;
  direction?: "ltr" | undefined;
}) {
  const { t } = useTranslation();

  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
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
  };
  const toggleWrap = () => setWrap((previous) => !previous);

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
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"} dir={direction}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? t("chat:disableSoftWrap") : t("chat:enableSoftWrap")}
            label={wrap ? t("chat:disableSoftWrap") : t("chat:enableSoftWrap")}
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
            title={copied ? t("chat:theme_copied") : t("chat:copyCode")}
            label={copied ? t("chat:theme_copied") : t("chat:copyCode")}
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

// Short columns keep their width and the table scrolls sideways only when they cannot all fit
// (see lib/markdownTableLayout.ts). Copy puts the table's own Markdown on the clipboard.
function MarkdownTable({
  source,
  children,
  ...props
}: React.ComponentProps<"table"> & {
  source: { start: number; end: number; column: number } | null;
}) {
  const { t } = useTranslation();
  const readSourceText = useContext(MarkdownSourceTextReaderContext);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  const copyLabel = isCopied ? t("chat:theme_copied") : t("chat:copyTable");
  const handleCopy = () => {
    if (!source) return;
    const markdown = extractTableMarkdown(readSourceText(), source);
    if (markdown) copyToClipboard(markdown);
  };

  return (
    <div className="chat-markdown-table">
      {source ? (
        <div className="chat-markdown-table__actions">
          <IconButton
            className="chat-markdown-table__action"
            onClick={handleCopy}
            title={copyLabel}
            label={copyLabel}
            size="icon-xs"
            variant="ghost"
          >
            {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </IconButton>
        </div>
      ) : null}
      <div className="chat-markdown-table__scroll">
        <table {...props}>{children}</table>
      </div>
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  language: string;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  sourceOffset: number;
}

type SyntaxHighlightingModule = typeof import("../lib/syntaxHighlighting");
let syntaxHighlightingModulePromise: Promise<SyntaxHighlightingModule> | null = null;

function getSyntaxHighlightingModulePromise(): Promise<SyntaxHighlightingModule> {
  syntaxHighlightingModulePromise ??= import("../lib/syntaxHighlighting");
  return syntaxHighlightingModulePromise;
}

// While a message streams, its open code block grows on every reveal commit (~25/s) and
// each commit re-tokenizes the whole block — quadratic in block length and the single
// largest renderer cost of a code-heavy turn. Highlight at most this often while
// streaming; the prefix already on screen stays put and the trailing value always lands,
// so the block converges to exactly the settled highlight.
// Each highlight costs roughly linearly in block length, so the cadence also stretches
// with size: small blocks stay at the base interval, a block at
// `STREAMING_CODE_HIGHLIGHT_SLOW_CHARS` is highlighted at most once per
// `STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS`, keeping per-second tokenization work bounded.
const STREAMING_CODE_HIGHLIGHT_INTERVAL_MS = 160;
const STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS = 1_000;
const STREAMING_CODE_HIGHLIGHT_BASE_CHARS = 8_000;
const STREAMING_CODE_HIGHLIGHT_SLOW_CHARS = 80_000;

export function streamingCodeHighlightIntervalMs(codeLength: number): number {
  if (codeLength <= STREAMING_CODE_HIGHLIGHT_BASE_CHARS) {
    return STREAMING_CODE_HIGHLIGHT_INTERVAL_MS;
  }
  const progress = Math.min(
    1,
    (codeLength - STREAMING_CODE_HIGHLIGHT_BASE_CHARS) /
      (STREAMING_CODE_HIGHLIGHT_SLOW_CHARS - STREAMING_CODE_HIGHLIGHT_BASE_CHARS),
  );
  return Math.round(
    STREAMING_CODE_HIGHLIGHT_INTERVAL_MS +
      progress * (STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS - STREAMING_CODE_HIGHLIGHT_INTERVAL_MS),
  );
}

function SuspenseShikiCodeBlock({
  language,
  code: liveCode,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps) {
  const code = useThrottledStreamingValue(
    liveCode,
    isStreaming,
    streamingCodeHighlightIntervalMs(liveCode.length),
  );
  const syntaxHighlighting = use(getSyntaxHighlightingModulePromise());
  return (
    <LoadedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
      sourceOffset={sourceOffset}
    />
  );
}

function LoadedShikiCodeBlock({
  syntaxHighlighting,
  language,
  code,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps & { syntaxHighlighting: SyntaxHighlightingModule }) {
  const cacheKey = syntaxHighlighting.createSyntaxHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming
    ? syntaxHighlighting.getCachedSyntaxHighlightedHtml(cacheKey)
    : null;

  if (cachedHighlightedHtml != null) {
    return <FindAwareShikiHtml html={cachedHighlightedHtml} sourceOffset={sourceOffset} />;
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      cacheKey={cacheKey}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
      sourceOffset={sourceOffset}
    />
  );
}

function UncachedShikiCodeBlock({
  syntaxHighlighting,
  cacheKey,
  language,
  code,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps & {
  syntaxHighlighting: SyntaxHighlightingModule;
  cacheKey: string;
}) {
  const highlighter = use(syntaxHighlighting.getSyntaxHighlighterPromise(language));
  const highlightedHtml = syntaxHighlighting.highlightCodeToHtmlWithFallback(
    highlighter,
    code,
    language,
    themeName,
  );

  useEffect(() => {
    if (!isStreaming) {
      syntaxHighlighting.cacheSyntaxHighlightedHtml(cacheKey, highlightedHtml, code);
    }
  }, [cacheKey, code, highlightedHtml, isStreaming, syntaxHighlighting]);

  return <FindAwareShikiHtml html={highlightedHtml} sourceOffset={sourceOffset} />;
}

interface MarkdownRenderContextValue {
  isInsideLink: boolean;
  cwd: ChatMarkdownProps["cwd"];
  threadId: ChatMarkdownProps["threadId"];
  imageAttachmentIdsBySource: ReadonlyMap<string, string>;
  knownAbsoluteFilePaths: string[] | undefined;
  diffThemeName: DiffThemeName;
  isStreaming: boolean;
  isUserVariant: boolean;
  usesAutomaticBlockDirection: boolean;
  mentionReferences: ChatMarkdownProps["mentionReferences"];
  onImageExpand: ChatMarkdownProps["onImageExpand"];
  onOpenThread: ChatMarkdownProps["onOpenThread"];
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
  resolvedTheme: ReturnType<typeof useTheme>["resolvedTheme"];
  terminalContexts: ChatMarkdownProps["terminalContexts"];
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(null);
// The raw message text changes with every streamed token; only code blocks and
// inline code read it, so it stays out of MarkdownRenderContext and the links,
// images and chips of settled blocks do not re-render per token.
const MarkdownSourceTextContext = createContext("");
// Reads the same text on demand (a table's Copy), without re-rendering per token.
const MarkdownSourceTextReaderContext = createContext<() => string>(() => "");

// Stable component types preserve code highlighting timers, copy state and image state.
const GITHUB_ALERTS: Record<GithubAlertKind, { titleKey: string; icon: LucideIcon }> = {
  note: { titleKey: "chat:note", icon: InfoIcon },
  tip: { titleKey: "chat:tip", icon: LightbulbIcon },
  important: { titleKey: "chat:important", icon: InfoIcon },
  warning: { titleKey: "chat:warning", icon: TriangleAlertIcon },
  caution: { titleKey: "chat:caution", icon: OctagonAlertIcon },
};

function TechnicalBidiIsolate(props: { active: boolean; children: ReactNode }) {
  if (!props.active) {
    return <>{props.children}</>;
  }
  return (
    <bdi className="chat-markdown-technical-isolate" dir="ltr">
      {props.children}
    </bdi>
  );
}

/**
 * A table keeps its columns in source order (`dir="ltr"` on the table), so cells
 * get their own direction from the rehype plugin instead of inheriting it.
 */
const MARKDOWN_COMPONENTS: Components = {
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const { t } = useTranslation();
    const kind = (props as { "data-github-alert"?: GithubAlertKind })["data-github-alert"];
    const alert = kind ? GITHUB_ALERTS[kind] : undefined;
    if (!alert) return <blockquote {...props}>{children}</blockquote>;
    const Icon = alert.icon;
    return (
      <blockquote {...props}>
        <p className="markdown-alert-title">
          <Icon aria-hidden className="size-[1.1em] shrink-0" />
          {t(alert.titleKey)}
        </p>
        {children}
      </blockquote>
    );
  },
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const context = useContext(MarkdownRenderContext)!;
    const {
      isUserVariant,
      usesAutomaticBlockDirection,
      cwd,
      knownAbsoluteFilePaths,
      resolvedTheme,
      onOpenThread,
    } = context;
    const linkedContext = useMemo(
      () => ({ ...context, onImageExpand: undefined, isInsideLink: true }),
      [context],
    );
    // Linked images belong to the link, not to the fullscreen gallery.
    const linkedChildren = (
      <MarkdownRenderContext.Provider value={linkedContext}>
        {children}
      </MarkdownRenderContext.Provider>
    );
    const linkActions = useContext(ChatLinkActionsContext);
    const restoredHref = href ? restoreLiteralDollarPlaceholders(href) : href;
    const threadHref = restoredHref?.startsWith("thread://")
      ? restoredHref.slice("thread://".length)
      : restoredHref?.startsWith("synara://thread/")
        ? decodeSynaraThreadLinkTarget(restoredHref.slice("synara://thread/".length))
        : null;
    if (threadHref && onOpenThread) {
      return (
        <button
          type="button"
          className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
          onClick={() => onOpenThread(ThreadId.makeUnsafe(threadHref))}
        >
          {linkedChildren}
        </button>
      );
    }
    const isExternalHttp = isExternalHttpHref(restoredHref);
    if (isUserVariant && isExternalHttp) {
      // GFM autolinks a pasted URL before the chips plugin can see it; when the
      // link text is just the URL itself, render the composer's link chip so a
      // pasted link looks identical in the composer and in the sent bubble.
      // Authored `[label](url)` links keep the regular anchor treatment below.
      const plainText = nodeToPlainText(children);
      if (
        plainText === restoredHref ||
        restoredHref === `http://${plainText}` ||
        restoredHref === `https://${plainText}`
      ) {
        return (
          <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
            <InlineLinkChip url={restoredHref} interactive />
          </TechnicalBidiIsolate>
        );
      }
    }
    const targetPath = isExternalHttp
      ? null
      : resolveChatFileChipTarget(restoredHref, cwd, knownAbsoluteFilePaths);
    if (!targetPath) {
      return (
        <a
          {...props}
          href={restoredHref}
          target="_blank"
          rel="noopener noreferrer"
          className={isExternalHttp ? MARKDOWN_EXTERNAL_LINK_CLASS_NAME : props.className}
          {...(isExternalHttp
            ? {
                // A plain click on a pull request or issue follows the user's setting (in
                // the app by default); cmd/ctrl-click keeps the default external open.
                onClick: (event: React.MouseEvent) => {
                  if (event.metaKey || event.ctrlKey) return;
                  const openGitHubItem = resolveGitHubItemClickOpener(restoredHref, linkActions);
                  if (!openGitHubItem) return;
                  event.preventDefault();
                  openGitHubItem(restoredHref);
                },
                onContextMenu: (event: React.MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void showLinkContextMenu({
                    url: restoredHref,
                    position: { x: event.clientX, y: event.clientY },
                    actions: linkActions,
                  });
                },
              }
            : {})}
        >
          {isExternalHttp ? (
            <LinkChipIcon url={restoredHref} className={MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME} />
          ) : null}
          {linkedChildren}
        </a>
      );
    }

    return (
      <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
        <OpenableFileChip
          targetPath={targetPath}
          theme={resolvedTheme}
          label={
            usesAutomaticBlockDirection ? <bdi dir="auto">{linkedChildren}</bdi> : linkedChildren
          }
          {...(restoredHref ? { href: restoredHref } : {})}
        />
      </TechnicalBidiIsolate>
    );
  },
  table: function MarkdownTableElement({ node, children, ...props }) {
    const { usesAutomaticBlockDirection } = useContext(MarkdownRenderContext)!;
    const start = node?.position?.start;
    const end = node?.position?.end;
    const source =
      start?.offset === undefined || end?.offset === undefined
        ? null
        : { start: start.offset, end: end.offset, column: start.column };
    return (
      // Column order follows the table's own direction, not the prose around
      // it, so an RTL message keeps its columns in source order. Cells carry
      // their own direction instead.
      <MarkdownTable
        source={source}
        {...props}
        dir={usesAutomaticBlockDirection ? "ltr" : undefined}
      >
        {children}
      </MarkdownTable>
    );
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { diffThemeName, isStreaming, isUserVariant, usesAutomaticBlockDirection } =
      useContext(MarkdownRenderContext)!;
    const sourceText = useContext(MarkdownSourceTextContext);
    const renderInlineVisual = useContext(InlineVisualEmbedContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return (
        <pre {...props} dir={usesAutomaticBlockDirection ? "ltr" : undefined}>
          {children}
        </pre>
      );
    }

    const rawFenceInfo = extractRawFenceInfo(codeBlock.className);
    // An agent places a visual in its reply with a fence naming the visual id.
    // Only this transcript's own visuals render; anything else stays code.
    if (rawFenceInfo === INLINE_VISUAL_EMBED_FENCE && renderInlineVisual && !isUserVariant) {
      const visualId = readInlineVisualEmbedId(codeBlock.code);
      const visual = visualId === null ? null : renderInlineVisual(visualId);
      if (visual !== null) return <div className="my-4 first:mt-0 last:mb-0">{visual}</div>;
      // The fence streams in before its id is complete.
      if (isStreaming && visualId === null) return null;
    }

    const fence = parseCodeFenceInfo(rawFenceInfo);
    const code = dedentCode(codeBlock.code);
    const blockStart = node?.position?.start?.offset ?? 0;
    const codeOffsetInSource = sourceText.indexOf(code, blockStart);
    const sourceOffset = codeOffsetInSource < 0 ? blockStart : codeOffsetInSource;
    const highlightedFallback = (
      <pre {...props}>
        <FindAwareCodeFallback code={code} sourceOffset={sourceOffset}>
          {children}
        </FindAwareCodeFallback>
      </pre>
    );

    return (
      <MarkdownCodeBlock
        code={code}
        fence={fence}
        direction={usesAutomaticBlockDirection ? "ltr" : undefined}
      >
        {code.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS ? (
          highlightedFallback
        ) : (
          <CodeHighlightErrorBoundary fallback={highlightedFallback}>
            <Suspense fallback={highlightedFallback}>
              <SuspenseShikiCodeBlock
                language={fence.language}
                code={code}
                themeName={diffThemeName}
                isStreaming={isStreaming}
                sourceOffset={sourceOffset}
              />
            </Suspense>
          </CodeHighlightErrorBoundary>
        )}
      </MarkdownCodeBlock>
    );
  },
  code: function MarkdownInlineCode({ node, className, children, ...props }) {
    const { knownAbsoluteFilePaths, cwd, resolvedTheme, usesAutomaticBlockDirection } =
      useContext(MarkdownRenderContext)!;
    const sourceText = useContext(MarkdownSourceTextContext);
    // Fenced blocks carry a `language-*` class and are rendered by `pre`;
    // only inline code (no class) that names a file becomes an openable
    // mention chip. Absolute local paths chip immediately. Relative names
    // chip only when that file actually exists in the chat workspace.
    if (!className) {
      const filePath = inlineCodeFilePath(nodeToPlainText(children));
      if (filePath) {
        const nodeStart = node?.position?.start?.offset ?? 0;
        const filePathOffset = sourceText.indexOf(filePath, nodeStart);
        const sourceOffset = filePathOffset < 0 ? nodeStart : filePathOffset;
        const findLabelProps = {
          label: <FindAwareMarkdownText text={filePath} sourceOffset={sourceOffset} />,
        };
        const knownTarget = resolveChatFileChipTarget(filePath, undefined, knownAbsoluteFilePaths);
        if (knownTarget) {
          return (
            <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
              <OpenableFileChip
                targetPath={knownTarget}
                theme={resolvedTheme}
                {...findLabelProps}
              />
            </TechnicalBidiIsolate>
          );
        }
        if (resolveMarkdownFileLinkTarget(filePath, cwd) && cwd) {
          return (
            <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
              <VerifiedWorkspaceFileChip
                rawReference={filePath}
                cwd={cwd}
                theme={resolvedTheme}
                {...findLabelProps}
              />
            </TechnicalBidiIsolate>
          );
        }
      }
    }
    return (
      <code className={className} {...props} dir={usesAutomaticBlockDirection ? "ltr" : undefined}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node: _node, src, alt: altProp, ...props }) {
    const { cwd, threadId, imageAttachmentIdsBySource, onImageExpand, isInsideLink } =
      useContext(MarkdownRenderContext)!;
    const alt = altProp ?? "";
    const restoredSrc = src ? restoreLiteralDollarPlaceholders(src) : "";
    const attachmentId = imageAttachmentIdsBySource.get(normalizeMarkdownImagePath(restoredSrc));
    if (attachmentId || isLocalImageMarkdownSrc(restoredSrc)) {
      return (
        <GeneratedMarkdownImage
          src={restoredSrc}
          alt={alt}
          cwd={cwd}
          threadId={threadId}
          attachmentId={attachmentId}
          onImageExpand={onImageExpand}
          isLinked={isInsideLink}
        />
      );
    }
    // Local videos play inline; remote video URLs keep the plain <img> path.
    if (isLocalVideoMarkdownSrc(restoredSrc)) {
      return (
        <GeneratedMarkdownVideo
          src={restoredSrc}
          alt={alt}
          cwd={cwd}
          threadId={threadId}
          isLinked={isInsideLink}
        />
      );
    }
    if (!onImageExpand || !restoredSrc) {
      return <img {...props} src={restoredSrc} alt={alt} loading="lazy" />;
    }
    const expandImage = (event: SyntheticEvent<HTMLImageElement>) => {
      event.preventDefault();
      onImageExpand(
        { images: [{ src: restoredSrc, name: alt || "Image" }], index: 0 },
        event.currentTarget,
      );
    };
    return (
      <img
        {...props}
        src={restoredSrc}
        alt={alt}
        loading="lazy"
        role="button"
        tabIndex={0}
        data-expandable-image=""
        onClick={expandImage}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") expandImage(event);
        }}
      />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    // Task items carry their source line down to the checkbox via context.
    const isTaskItem =
      typeof props.className === "string" && props.className.includes("task-list-item");
    const sourceLine = node?.position?.start.line ?? null;
    if (!isTaskItem || sourceLine === null) {
      return <li {...props}>{children}</li>;
    }
    return (
      <li {...props}>
        <TaskItemSourceLineContext.Provider value={sourceLine}>
          {children}
        </TaskItemSourceLineContext.Provider>
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, ...props }) {
    const { onTaskToggle } = useContext(MarkdownRenderContext)!;
    if (props.type === "checkbox") {
      return <MarkdownTaskCheckbox checked={props.checked === true} onTaskToggle={onTaskToggle} />;
    }
    return <input {...props} />;
  },
  // Custom elements emitted by the composer-chips remark plugin (user
  // variant only; they never appear in assistant markdown). `Components`
  // only models intrinsic tags, so these entries are typed on their own
  // and cast into the map.
  ...({
    [COMPOSER_CHIP_TAG_NAME]: function MarkdownComposerChip(props: {
      className?: string | undefined;
      [COMPOSER_CHIP_SEGMENT_ATTRIBUTE]?: string | undefined;
    }) {
      const { resolvedTheme, mentionReferences, usesAutomaticBlockDirection } =
        useContext(MarkdownRenderContext)!;
      return (
        <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
          <ComposerChipElement
            serializedSegment={props[COMPOSER_CHIP_SEGMENT_ATTRIBUTE]}
            theme={resolvedTheme}
            mentionReferences={mentionReferences ?? []}
          />
        </TechnicalBidiIsolate>
      );
    },
    [TERMINAL_CONTEXT_CHIP_TAG_NAME]: function MarkdownTerminalChip(props: {
      [TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE]?: string | undefined;
    }) {
      const { terminalContexts, usesAutomaticBlockDirection } = useContext(MarkdownRenderContext)!;
      const rawIndex = props[TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE];
      const index = rawIndex === undefined ? Number.NaN : Number.parseInt(rawIndex, 10);
      const context = Number.isInteger(index) ? terminalContexts?.[index] : undefined;
      if (!context) {
        return null;
      }
      const tooltipText =
        context.body.length > 0 ? `${context.header}\n${context.body}` : context.header;
      return (
        <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
          <TerminalContextInlineChip label={context.header} tooltipText={tooltipText} />
        </TechnicalBidiIsolate>
      );
    },
    [CHAT_FIND_TEXT_TAG_NAME]: function MarkdownFindText(props: {
      children?: ReactNode;
      [CHAT_FIND_TEXT_START_ATTRIBUTE]?: string | undefined;
    }) {
      const rawSourceOffset = props[CHAT_FIND_TEXT_START_ATTRIBUTE];
      const sourceOffset =
        rawSourceOffset === undefined ? Number.NaN : Number.parseInt(rawSourceOffset, 10);
      const text = nodeToPlainText(props.children);
      if (!Number.isFinite(sourceOffset) || text.length === 0) {
        return <>{props.children}</>;
      }
      return <FindAwareMarkdownText text={text} sourceOffset={sourceOffset} />;
    },
  } as unknown as Components),
};

function stringArraysEqual(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function ChatMarkdown({
  text,
  cwd,
  threadId,
  imageAttachments,
  directionMode: directionModeProp,
  wikiLinkRoot,
  isStreaming: isStreamingProp,
  className: classNameProp,
  style,
  onImageExpand,
  findQuery: findQueryProp,
  findActiveRange: findActiveRangeProp,
  onTaskToggle,
  knownAbsoluteFilePaths: knownAbsoluteFilePathsProp,
  variant: variantProp,
  mentionReferences,
  terminalContexts,
  onOpenThread,
  parseHtml: parseHtmlProp,
  shareParse: shareParseProp,
}: ChatMarkdownProps) {
  // Defaults applied with ?? in the body, not in the destructuring: default
  // values in parameter destructuring make React Compiler 1.0.0 bail on the
  // whole component (BuildHIR AssignmentPattern), losing its auto-memoization.
  const isStreaming = isStreamingProp ?? false;
  const className = classNameProp ?? "text-chat leading-relaxed";
  const variant = variantProp ?? "assistant";
  const directionMode = directionModeProp ?? "off";
  const usesAutomaticBlockDirection = directionMode === "auto-blocks";
  // The message's own direction is the inherited default (bare text, images, and
  // blocks with no letters of their own); each prose block then overrides it from
  // its own dominant script, so a bilingual reply keeps Persian paragraphs RTL
  // and English paragraphs LTR in the same message.
  const textDirection = useMemo(
    () => (usesAutomaticBlockDirection ? resolveMarkdownTextDirection(text) : undefined),
    [text, usesAutomaticBlockDirection],
  );
  const parseHtml = parseHtmlProp ?? false;
  const findQuery = findQueryProp ?? "";
  const findActiveRange = findActiveRangeProp ?? null;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const isUserVariant = variant === "user";
  // Resolve only this assistant message's immutable images, without rescanning streamed text.
  const imageAttachmentIdsBySource = useMemo(() => {
    const aliases = new Map<string, string>();
    if (!isUserVariant) {
      for (const attachment of imageAttachments ?? []) {
        if (attachment.type === "image" && attachment.sourcePath) {
          aliases.set(attachment.sourcePath, attachment.id);
        }
      }
    }
    return aliases;
  }, [imageAttachments, isUserVariant]);
  // A fresh array per streamed token would rebuild the render context and
  // re-render every link and code node; keep it while its paths are unchanged.
  const extractedAbsoluteFilePaths = useStableValue(
    useMemo(() => extractAbsoluteFilesystemPaths(text), [text]),
    stringArraysEqual,
  );
  const knownAbsoluteFilePaths = useMemo(() => {
    if (
      (knownAbsoluteFilePathsProp === undefined || knownAbsoluteFilePathsProp.length === 0) &&
      extractedAbsoluteFilePaths.length === 0
    ) {
      return undefined;
    }
    return [...new Set([...(knownAbsoluteFilePathsProp ?? []), ...extractedAbsoluteFilePaths])];
  }, [extractedAbsoluteFilePaths, knownAbsoluteFilePathsProp]);
  // Reveal streamed text at a steady, adaptive cadence so tokens appear fluidly instead of
  // in the ~100ms network clumps that land in the store. No-ops (returns `text`) when not
  // streaming or under reduced motion. Governs cadence only; the deferred value below still
  // bounds the markdown re-parse cost.
  const smoothedText = useSmoothStreamedText(text, isStreaming);
  // The dollar rewrite exists to disambiguate math from currency; the user
  // variant has no math, so its text must stay byte-for-byte what was typed.
  // Table repair runs first so find offsets use the same normalized text.
  const sourceText = useMemo(
    () => (isUserVariant || !text.includes("|") ? text : repairMarkdownTableDelimiters(text)),
    [isUserVariant, text],
  );
  const normalizedMarkdown = useMemo(() => {
    if (isUserVariant) return { text: smoothedText, hasMath: false };
    // Once the reveal has caught up (and always outside streaming) the smoothed
    // text is the raw text, whose repair is already done above.
    const repairedText =
      smoothedText === text
        ? sourceText
        : smoothedText.includes("|")
          ? repairMarkdownTableDelimiters(smoothedText)
          : smoothedText;
    return repairedText.includes("$") ||
      repairedText.includes("\\(") ||
      repairedText.includes("\\[")
      ? protectLiteralMarkdownDollars(repairedText)
      : { text: repairedText, hasMath: false };
  }, [isUserVariant, smoothedText, text, sourceText]);
  // While streaming, let React deprioritize and coalesce the markdown re-parse so a
  // fast token stream (one flush per ~100ms) doesn't re-render the full ReactMarkdown
  // tree on every flush. The deferred value always converges to the latest text, and
  // completed messages render the exact current text immediately (no visual change).
  const deferredMarkdown = useDeferredValue(normalizedMarkdown);
  const { text: renderedText, hasMath: needsMathPlugins } = isStreaming
    ? deferredMarkdown
    : normalizedMarkdown;
  // Only streaming assistant markdown is split; authored HTML previews go
  // through rehype-raw, which re-parses positions, and are never streamed.
  const splitBlocks = isStreaming && !isUserVariant && !parseHtml;
  const [mathPlugins, setMathPlugins] = useState<MathPluginsBundle | null>(() => cachedMathPlugins);
  const [authoredHtmlPlugins, setAuthoredHtmlPlugins] = useState<AuthoredHtmlPluginsBundle | null>(
    () => cachedAuthoredHtmlPlugins,
  );
  useEffect(() => {
    if (!needsMathPlugins || mathPlugins !== null) return;
    let cancelled = false;
    void loadMathPlugins().then((loaded) => {
      if (!cancelled) setMathPlugins(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [needsMathPlugins, mathPlugins]);
  useEffect(() => {
    if (!parseHtml || isUserVariant || authoredHtmlPlugins !== null) return;
    let cancelled = false;
    void loadAuthoredHtmlPlugins().then((loaded) => {
      if (!cancelled) setAuthoredHtmlPlugins(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [parseHtml, isUserVariant, authoredHtmlPlugins]);
  // Find ranges are empty without a query; keep the provider's value stable
  // then instead of recomputing it (and every text node) per streamed token.
  const normalizedFindQuery = normalizeFindQuery(findQuery);
  const findSourceText = normalizedFindQuery.length > 0 ? sourceText : "";
  const readSourceText = useStableCallback(() => sourceText);
  const composerChipsRemarkPlugin = useMemo(
    () =>
      isUserVariant
        ? createComposerChipsRemarkPlugin(
            mentionReferences ?? [],
            (terminalContexts ?? []).map((context, index) => ({
              label: formatInlineTerminalContextLabel(context.header),
              index,
            })),
          )
        : null,
    [isUserVariant, mentionReferences, terminalContexts],
  );
  const activeMathPlugin = needsMathPlugins ? mathPlugins : null;
  const remarkPlugins = useMemo<MarkdownRemarkPlugins>(() => {
    if (composerChipsRemarkPlugin) {
      return [...USER_MARKDOWN_REMARK_PLUGINS, composerChipsRemarkPlugin, remarkFindableText];
    }
    return [
      ...(activeMathPlugin
        ? [
            remarkGfm,
            activeMathPlugin.remarkMath,
            remarkGithubAlerts,
            remarkHtmlBreaks,
            remarkImageRows,
          ]
        : BASE_MARKDOWN_REMARK_PLUGINS),
      [remarkWikiLinks, { root: wikiLinkRoot ?? cwd }],
      remarkFindableText,
    ];
  }, [composerChipsRemarkPlugin, activeMathPlugin, wikiLinkRoot, cwd]);
  const activeAuthoredHtmlPlugins =
    !isUserVariant && parseHtml ? (authoredHtmlPlugins?.plugins ?? null) : null;
  const rehypePlugins = useMemo<MarkdownRehypePlugins>(() => {
    // Raw HTML is only enabled for authored local-file previews. Sanitize
    // immediately after parsing so scripts, event handlers, and unsafe URL
    // schemes never reach React's renderer.
    const mathAndLiteralRehype: MarkdownRehypePlugins = activeMathPlugin
      ? [
          [rehypeTableLayout, restoreLiteralDollarPlaceholders],
          activeMathPlugin.rehypeKatex,
          rehypeRestoreLiteralDollars,
        ]
      : BASE_MARKDOWN_REHYPE_PLUGINS;
    const basePlugins: MarkdownRehypePlugins = isUserVariant
      ? USER_MARKDOWN_REHYPE_PLUGINS
      : activeAuthoredHtmlPlugins
        ? [...activeAuthoredHtmlPlugins, ...mathAndLiteralRehype]
        : mathAndLiteralRehype;
    return usesAutomaticBlockDirection ? [...basePlugins, rehypeBidiBlockDirection] : basePlugins;
  }, [isUserVariant, activeAuthoredHtmlPlugins, activeMathPlugin, usesAutomaticBlockDirection]);
  // The parse depends on the text plus exactly these inputs (see remarkPlugins and
  // rehypePlugins above). User messages carry per-message chip plugins and are not shared.
  // Only opted-in callers share (see `parsedMarkdownCache`).
  const parseCacheScope =
    !shareParseProp || isStreaming || composerChipsRemarkPlugin
      ? null
      : `${activeAuthoredHtmlPlugins ? 1 : 0}${activeMathPlugin ? 1 : 0}${usesAutomaticBlockDirection ? 1 : 0}:${wikiLinkRoot ?? cwd ?? ""}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hadFindHighlightRef = useRef(false);
  useLayoutEffect(() => {
    const hasFind = normalizedFindQuery.length > 0 || findActiveRange !== null;
    if (!hasFind && !hadFindHighlightRef.current) return;
    hadFindHighlightRef.current = hasFind;
    applyActiveChatFindMatch(rootRef.current, findActiveRange);
  }, [findActiveRange, normalizedFindQuery, renderedText]);
  const renderContext = useMemo<MarkdownRenderContextValue>(
    () => ({
      isInsideLink: false,
      cwd,
      threadId,
      imageAttachmentIdsBySource,
      knownAbsoluteFilePaths,
      diffThemeName,
      isStreaming,
      isUserVariant,
      usesAutomaticBlockDirection,
      mentionReferences,
      onImageExpand,
      onOpenThread,
      onTaskToggle,
      resolvedTheme,
      terminalContexts,
    }),
    [
      cwd,
      threadId,
      imageAttachmentIdsBySource,
      knownAbsoluteFilePaths,
      diffThemeName,
      isStreaming,
      isUserVariant,
      usesAutomaticBlockDirection,
      mentionReferences,
      onImageExpand,
      onOpenThread,
      onTaskToggle,
      resolvedTheme,
      terminalContexts,
    ],
  );

  return (
    <div
      ref={rootRef}
      className={`chat-markdown ${isUserVariant ? "chat-markdown--user " : ""}w-full min-w-0 ${className} text-foreground`}
      {...(usesAutomaticBlockDirection ? { "data-direction-mode": "auto-blocks" } : {})}
      dir={textDirection}
      style={style}
    >
      <ChatFindRenderProvider
        query={findQuery}
        sourceText={findSourceText}
        activeRange={findActiveRange}
      >
        <MarkdownRenderContext.Provider value={renderContext}>
          <MarkdownSourceTextContext.Provider value={findSourceText}>
            <MarkdownSourceTextReaderContext.Provider value={readSourceText}>
              <ParsedMarkdown
                text={renderedText}
                splitBlocks={splitBlocks}
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                components={MARKDOWN_COMPONENTS}
                parseCacheScope={parseCacheScope}
              />
            </MarkdownSourceTextReaderContext.Provider>
          </MarkdownSourceTextContext.Provider>
        </MarkdownRenderContext.Provider>
      </ChatFindRenderProvider>
    </div>
  );
}

export default memo(ChatMarkdown);
