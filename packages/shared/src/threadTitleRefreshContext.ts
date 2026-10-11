import { redactDiagnosticText } from "./diagnosticsRedaction";

export const THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS = 2_000;
export const THREAD_TITLE_REFRESH_MAX_INTENTS = 5;

export interface ThreadTitleRefreshContextInput {
  readonly currentTitle: string;
  readonly recentUserIntents: ReadonlyArray<string>;
  readonly compactSummary: string | null | undefined;
}

function normalize(value: string): string {
  return redactDiagnosticText(value.slice(0, THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS), {
    maxLength: THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS,
  })
    .replace(/\s+/g, " ")
    .trim();
}

function quote(value: string): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

/** Bounded reference text; recognized sensitive patterns use the existing shared redactor. */
export function buildThreadTitleRefreshContext(
  input: ThreadTitleRefreshContextInput,
  maxChars = THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS,
): string | null {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.min(Math.floor(maxChars), THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS))
    : THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS;
  if (limit === 0) return null;
  let title = normalize(input.currentTitle);
  const intents = input.recentUserIntents
    .slice(-THREAD_TITLE_REFRESH_MAX_INTENTS)
    .map(normalize)
    .filter((intent) => intent.length > 0);
  let summary = normalize(input.compactSummary ?? "");
  if (intents.length === 0 && !summary) return null;
  const render = () =>
    [
      ...(title ? [`Current title: ${quote(title)}`] : []),
      ...intents.map((intent) => `User intent: ${quote(intent)}`),
      ...(summary ? [`Summary: ${quote(summary)}`] : []),
    ].join("\n");
  let context = render();
  while (context.length > limit && intents.length > 1) {
    intents.shift();
    context = render();
  }
  if (context.length > limit && summary && intents.length > 0) {
    summary = "";
    context = render();
  }
  if (context.length > limit && title) {
    title = "";
    context = render();
  }
  while (context.length > limit && (intents.length > 0 || summary)) {
    const excess = Math.max(1, context.length - limit);
    if (intents.length > 0) {
      intents[0] = intents[0]!.slice(0, Math.max(0, intents[0]!.length - excess));
      if (!intents[0]) intents.shift();
    } else summary = summary.slice(0, Math.max(0, summary.length - excess));
    context = render();
  }
  return context || null;
}
