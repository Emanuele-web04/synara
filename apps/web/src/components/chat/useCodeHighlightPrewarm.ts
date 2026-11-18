// FILE: useCodeHighlightPrewarm.ts
// Purpose: While the transcript is idle, highlight the code blocks of settled assistant
//          messages (newest first) into the shared syntax-highlight cache, so scrolling
//          up a long chat mounts rows with ready HTML. Pauses while the list scrolls,
//          while input is pending and while the thread is working.
// Layer: React hook (chat timeline)
// Depends on: codeHighlightPrewarm (pure scheduler), useTheme.

import { useEffect, useMemo, useRef } from "react";

import { useResolvedTheme } from "../../hooks/useTheme";
import {
  codeHighlightJobsForMarkdown,
  createCodeHighlightPrewarmer,
  type CodeHighlightJob,
  type CodeHighlightPrewarmHost,
} from "../../lib/codeHighlightPrewarm";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Scroll events within this window count as active scrolling. */
const SCROLL_QUIET_MS = 250;
/** Fallback slice when `requestIdleCallback` is missing (Safari). */
const FALLBACK_IDLE_DELAY_MS = 200;
const FALLBACK_IDLE_BUDGET_MS = 8;

const jobsByText = new Map<string, readonly CodeHighlightJob[]>();
const MAX_MEMOIZED_TEXTS = 2_000;

function jobsForText(text: string): readonly CodeHighlightJob[] {
  const cached = jobsByText.get(text);
  if (cached) return cached;
  const jobs = codeHighlightJobsForMarkdown(text);
  if (jobsByText.size >= MAX_MEMOIZED_TEXTS) jobsByText.clear();
  jobsByText.set(text, jobs);
  return jobs;
}

function requestIdle(callback: (deadline: { timeRemaining(): number }) => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(callback);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => {
    const startedAt = performance.now();
    callback({
      timeRemaining: () => Math.max(0, FALLBACK_IDLE_BUDGET_MS - (performance.now() - startedAt)),
    });
  }, FALLBACK_IDLE_DELAY_MS);
  return () => clearTimeout(id);
}

function isInputPending(): boolean {
  const scheduling = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } })
    .scheduling;
  return scheduling?.isInputPending?.() ?? false;
}

export function useCodeHighlightPrewarm(input: {
  rows: readonly MessagesTimelineRow[];
  enabled: boolean;
  getScrollElement: () => HTMLElement | null;
}) {
  const { rows, enabled, getScrollElement } = input;
  const resolvedTheme = useResolvedTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const lastScrollAtRef = useRef(0);

  const prewarmer = useMemo(() => {
    const host: CodeHighlightPrewarmHost = {
      requestIdle,
      isBusy: () =>
        performance.now() - lastScrollAtRef.current < SCROLL_QUIET_MS || isInputPending(),
      loadHighlighting: () => import("../../lib/syntaxHighlighting"),
    };
    return createCodeHighlightPrewarmer(host);
  }, []);

  useEffect(() => () => prewarmer.cancel(), [prewarmer]);

  useEffect(() => {
    const element = enabled ? getScrollElement() : null;
    if (!element) return;
    const onScroll = () => {
      lastScrollAtRef.current = performance.now();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [enabled, getScrollElement]);

  // Settled assistant messages, newest first: the rows a reader reaches first when
  // scrolling up from the end. Only the text identity matters for the queue.
  const settled = useMemo(() => {
    const texts: string[] = [];
    let signature = "";
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind !== "message") continue;
      const message = row.message;
      if (message.role !== "assistant" || message.streaming || message.text.length === 0) continue;
      texts.push(message.text);
      if (signature === "") signature = `${message.id}:${message.text.length}`;
    }
    return { texts, signature: `${texts.length}:${signature}` };
  }, [rows]);
  // Rows re-derive on store writes that leave the settled messages alone; the queue
  // restarts only when they change (a message settles, or the thread changes).
  const textsRef = useRef(settled.texts);
  useEffect(() => {
    textsRef.current = settled.texts;
  }, [settled.texts]);

  useEffect(() => {
    if (!enabled) return;
    prewarmer.start(
      textsRef.current.flatMap((text) => jobsForText(text)),
      themeName,
    );
    return () => prewarmer.cancel();
  }, [enabled, prewarmer, settled.signature, themeName]);
}
