// FILE: codeHighlightPrewarm.ts
// Purpose: Highlight the fenced code blocks of settled transcript messages while the
//          renderer is idle, so rows that mount later (scrolling up a long chat) find
//          their HTML in the shared syntax-highlight cache instead of tokenizing
//          synchronously inside the scroll frame.
// Layer: Web chat utility
// Depends on: syntaxHighlighting (loaded lazily, as ChatMarkdown does), codeFence.
//
// Nothing here renders. It only fills the cache ChatMarkdown already reads, with the
// same (code, language, theme) key and the same highlighter call, so a prewarmed block
// renders exactly what an uncached one would have rendered.

import { INLINE_VISUAL_EMBED_FENCE } from "@synara/contracts";

import { dedentCode, parseCodeFenceInfo } from "./codeFence";
import type { DiffThemeName } from "./diffRendering";
import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "./syntaxHighlightingLimits";

export interface FencedCodeBlock {
  /** First word of the fence info string, as `language-<word>` reaches ChatMarkdown. */
  readonly rawInfo: string;
  /** The code exactly as ChatMarkdown hands it to the highlighter. */
  readonly code: string;
}

const FENCE_OPEN_REGEX = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/**
 * Fenced code blocks of a markdown message, in source order. Mirrors what the
 * remark/rehype pipeline produces for a fence: the lines between the fences with the
 * opening fence's indentation removed, plus the trailing newline mdast-util-to-hast
 * appends, then ChatMarkdown's `dedentCode`. A block this scanner reads differently
 * from the real parser only produces an unused cache entry, never a wrong render.
 */
export function extractFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
  if (!markdown.includes("```") && !markdown.includes("~~~")) return [];
  const lines = markdown.split("\n");
  const blocks: FencedCodeBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN_REGEX.exec(lines[index]!);
    if (!open) continue;
    const indent = open[1]!.length;
    const fence = open[2]!;
    const info = open[3]!.trim();
    // A backtick fence's info string cannot contain a backtick (CommonMark).
    if (fence[0] === "`" && info.includes("`")) continue;
    const body: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      const trimmed = line.trim();
      if (
        trimmed.length >= fence.length &&
        trimmed[0] === fence[0] &&
        [...trimmed].every((character) => character === fence[0])
      ) {
        closed = true;
        break;
      }
      body.push(stripIndent(line, indent));
    }
    index = closed ? cursor : lines.length;
    const value = body.join("\n");
    blocks.push({
      rawInfo: info.split(/\s+/)[0] || "text",
      code: dedentCode(value.length > 0 ? `${value}\n` : ""),
    });
  }
  return blocks;
}

function stripIndent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && (line[cut] === " " || line[cut] === "\t")) cut += 1;
  return line.slice(cut);
}

export interface CodeHighlightJob {
  readonly code: string;
  readonly language: string;
}

/** Highlight jobs for one message, skipping what ChatMarkdown never highlights. */
export function codeHighlightJobsForMarkdown(markdown: string): CodeHighlightJob[] {
  const jobs: CodeHighlightJob[] = [];
  for (const block of extractFencedCodeBlocks(markdown)) {
    if (block.rawInfo === INLINE_VISUAL_EMBED_FENCE) continue;
    if (block.code.length === 0 || block.code.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS) continue;
    jobs.push({ code: block.code, language: parseCodeFenceInfo(block.rawInfo).language });
  }
  return jobs;
}

export interface CodeHighlightPrewarmHost {
  /** Same contract as `requestIdleCallback`; returns a cancel function. */
  requestIdle(callback: (deadline: { timeRemaining(): number }) => void): () => void;
  /** True while the user is interacting (scrolling, pending input): no work starts. */
  isBusy(): boolean;
  loadHighlighting(): Promise<CodeHighlightingApi>;
}

export interface CodeHighlightingApi {
  createSyntaxHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string;
  getCachedSyntaxHighlightedHtml(cacheKey: string): string | null;
  cacheSyntaxHighlightedHtml(cacheKey: string, html: string, code: string): void;
  getSyntaxHighlighterPromise(language: string): Promise<unknown>;
  highlightCodeToHtmlWithFallback(
    highlighter: never,
    code: string,
    language: string,
    themeName: DiffThemeName,
  ): string;
}

/** Below this much idle time left, a block is not started (one block is not divisible). */
export const PREWARM_MIN_IDLE_MS = 6;
/** Blocks longer than this stay on the render path: one could exceed a whole idle period. */
export const PREWARM_MAX_BLOCK_CHARS = 12_000;
/** Per thread; well under the cache's 500 entries so other surfaces keep their HTML. */
export const PREWARM_MAX_BLOCKS = 120;

export interface CodeHighlightPrewarmer {
  /** Replaces the queue. Jobs run in order; already cached ones are skipped. */
  start(jobs: readonly CodeHighlightJob[], themeName: DiffThemeName): void;
  cancel(): void;
}

export function createCodeHighlightPrewarmer(
  host: CodeHighlightPrewarmHost,
): CodeHighlightPrewarmer {
  let generation = 0;
  let cancelIdle: (() => void) | null = null;

  const cancel = () => {
    generation += 1;
    cancelIdle?.();
    cancelIdle = null;
  };

  const start = (jobs: readonly CodeHighlightJob[], themeName: DiffThemeName) => {
    cancel();
    const queue = jobs
      .filter((job) => job.code.length <= PREWARM_MAX_BLOCK_CHARS)
      .slice(0, PREWARM_MAX_BLOCKS);
    if (queue.length === 0) return;
    const runGeneration = generation;
    let api: CodeHighlightingApi | null = null;
    let next = 0;
    // Languages whose highlighter is loaded; loading one is async and runs between slices.
    const loaded = new Map<string, unknown>();
    const pendingLoads = new Set<string>();

    const schedule = () => {
      if (runGeneration !== generation || next >= queue.length) {
        cancelIdle = null;
        return;
      }
      cancelIdle = host.requestIdle(slice);
    };

    const slice = (deadline: { timeRemaining(): number }) => {
      cancelIdle = null;
      if (runGeneration !== generation) return;
      if (api === null) {
        void host.loadHighlighting().then((module) => {
          api = module;
          schedule();
        });
        return;
      }
      while (
        next < queue.length &&
        !host.isBusy() &&
        deadline.timeRemaining() >= PREWARM_MIN_IDLE_MS
      ) {
        const job = queue[next]!;
        const cacheKey = api.createSyntaxHighlightCacheKey(job.code, job.language, themeName);
        if (api.getCachedSyntaxHighlightedHtml(cacheKey) !== null) {
          next += 1;
          continue;
        }
        const highlighter = loaded.get(job.language);
        if (highlighter === undefined) {
          if (!pendingLoads.has(job.language)) {
            pendingLoads.add(job.language);
            void api.getSyntaxHighlighterPromise(job.language).then(
              (value) => {
                loaded.set(job.language, value);
                pendingLoads.delete(job.language);
                schedule();
              },
              () => {
                // The render path reports highlighter failures; drop this language here.
                pendingLoads.delete(job.language);
                for (let index = next; index < queue.length; index += 1) {
                  if (queue[index]!.language === job.language) queue.splice(index--, 1);
                }
                schedule();
              },
            );
          }
          return;
        }
        const html = api.highlightCodeToHtmlWithFallback(
          highlighter as never,
          job.code,
          job.language,
          themeName,
        );
        api.cacheSyntaxHighlightedHtml(cacheKey, html, job.code);
        next += 1;
      }
      schedule();
    };

    schedule();
  };

  return { start, cancel };
}
