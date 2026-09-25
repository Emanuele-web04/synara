// FILE: ChatMarkdownFind.tsx
// Purpose: Applies in-thread find decoration after markdown parsing.
// Layer: Web chat presentation helper

import React, { useMemo, type ReactNode } from "react";

import {
  collectCaseInsensitiveSubstringRanges,
  normalizeFindQuery,
  splitTextWithFindMatches,
  splitTextWithFindRanges,
  wrapFindQueryInHtml,
  type ThreadFindRange,
} from "./chat/threadFind.logic";

interface ChatFindRenderState {
  query: string;
  ranges: readonly ThreadFindRange[];
  activeRange: ThreadFindRange | null;
}

const EMPTY_CHAT_FIND_RENDER_STATE: ChatFindRenderState = {
  query: "",
  ranges: [],
  activeRange: null,
};

const ChatFindRenderContext = React.createContext<ChatFindRenderState>(
  EMPTY_CHAT_FIND_RENDER_STATE,
);

export function ChatFindRenderProvider(props: {
  query: string;
  sourceText: string;
  activeRange: ThreadFindRange | null;
  children: ReactNode;
}) {
  const ranges = useMemo(
    () => collectCaseInsensitiveSubstringRanges(props.sourceText, props.query),
    [props.query, props.sourceText],
  );
  const value = useMemo<ChatFindRenderState>(
    () => ({ query: props.query, ranges, activeRange: props.activeRange }),
    [props.activeRange, props.query, ranges],
  );
  return (
    <ChatFindRenderContext.Provider value={value}>{props.children}</ChatFindRenderContext.Provider>
  );
}

function findMatchClassName(part: {
  active: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
}): string {
  return [
    "chat-find-match",
    part.active ? "chat-find-match-active" : "",
    part.continuesBefore ? "chat-find-match-continues-before" : "",
    part.continuesAfter ? "chat-find-match-continues-after" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Past this many words-worth of source offset (~5k words) the fade stops adding
// value and word spans would only grow the DOM — emit bare text instead.
export const WORD_FADE_MAX_OFFSET = 30_000;

interface WordFadeRenderOptions {
  /** Words starting below this absolute offset render without the fade. */
  instantBelow: number;
}

/**
 * Split `text` into one keyed span per word with bare whitespace siblings.
 * Keys are the word's absolute source offset (`w:<offset>`), stable under
 * append: a growing paragraph adds spans without remounting earlier ones, so
 * an already-shown word never re-fades.
 */
function fadeWords(text: string, baseOffset: number, instantBelow: number): ReactNode[] {
  let offset = baseOffset;
  return text
    .split(/(\s+)/)
    .filter(Boolean)
    .map((part) => {
      const start = offset;
      offset += part.length;
      if (/^\s/.test(part)) return part;
      if (start >= WORD_FADE_MAX_OFFSET) return part;
      return (
        <span key={`w:${start}`} data-chat-word-fade={start < instantBelow ? "instant" : ""}>
          {part}
        </span>
      );
    });
}

function renderFindTextParts(
  parts: ReturnType<typeof splitTextWithFindMatches>,
  fade?: WordFadeRenderOptions,
  sourceOffset = 0,
): ReactNode {
  if (parts.length === 1 && !parts[0]!.match && !fade) {
    return parts[0]!.text;
  }
  let cursor = sourceOffset;
  return parts.map((part, index) => {
    const partStart = cursor;
    cursor += part.text.length;
    if (part.match) {
      return (
        <span
          key={`${part.startOffset ?? index}:${index}`}
          className={findMatchClassName(part)}
          data-chat-find-match={part.active ? "active" : "true"}
          data-chat-find-start={part.startOffset}
        >
          {part.text}
        </span>
      );
    }
    if (fade) {
      return fadeWords(part.text, partStart, fade.instantBelow);
    }
    return <span key={`text:${index}`}>{part.text}</span>;
  });
}

function renderFindWrappedText(
  text: string,
  query: string,
  activeRange: ThreadFindRange | null,
  sourceOffset: number,
): ReactNode {
  return renderFindTextParts(splitTextWithFindMatches(text, query, activeRange, sourceOffset));
}

export function FindAwareMarkdownText(props: {
  text: string;
  sourceOffset: number;
  fade?: WordFadeRenderOptions | undefined;
}) {
  const highlight = React.useContext(ChatFindRenderContext);
  return renderFindTextParts(
    splitTextWithFindRanges(
      props.text,
      highlight.ranges,
      highlight.activeRange,
      props.sourceOffset,
    ),
    props.fade,
    props.sourceOffset,
  );
}

export function FindAwareCodeFallback(props: {
  children: ReactNode;
  code: string;
  sourceOffset: number;
}) {
  const highlight = React.useContext(ChatFindRenderContext);
  if (normalizeFindQuery(highlight.query).length === 0) {
    return props.children;
  }
  return (
    <code>
      {renderFindWrappedText(
        props.code,
        highlight.query,
        highlight.activeRange,
        props.sourceOffset,
      )}
    </code>
  );
}

export function FindAwareShikiHtml(props: { html: string; sourceOffset: number }) {
  const highlight = React.useContext(ChatFindRenderContext);
  const html =
    normalizeFindQuery(highlight.query).length > 0
      ? wrapFindQueryInHtml(props.html, highlight.query, props.sourceOffset, highlight.activeRange)
      : props.html;
  return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}
