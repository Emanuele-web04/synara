import type { NotionObject } from "@synara/contracts";
import {
  notionArray,
  notionCanonical,
  notionObject,
  notionString,
  notionText,
  safeNotionLink,
} from "@synara/shared/notion";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

export function validateNotionRichTextDraft(
  original: readonly unknown[],
  next: readonly unknown[],
): void {
  if (next.length > 100) throw new Error("A block supports at most 100 text runs.");
  const preserved = (runs: readonly unknown[]) =>
    runs
      .filter((raw) => {
        const run = notionObject(raw);
        return run.type && run.type !== "text";
      })
      .map(notionCanonical);
  if (notionCanonical(preserved(original)) !== notionCanonical(preserved(next)))
    throw new Error("Unsupported runs and mentions must be preserved unchanged.");
  for (const raw of next) {
    const run = notionObject(raw);
    if (run.type && run.type !== "text") continue;
    const text = notionObject(run.text);
    if (typeof text.content !== "string" || text.content.length > 2000)
      throw new Error("Each text run must contain at most 2,000 characters.");
    const link = notionObject(text.link).url;
    if (link != null && !safeNotionLink(link))
      throw new Error("Enter a complete http, https or mailto link before saving.");
  }
}
export function NotionRichText({ runs }: { runs: readonly unknown[] }) {
  return (
    <>
      {runs.map((raw, index) => {
        const run = notionObject(raw);
        const marks = notionObject(run.annotations);
        const text =
          notionString(notionObject(run.text).content) ||
          notionString(run.plain_text) ||
          notionString(notionObject(run.equation).expression);
        const link = safeNotionLink(notionObject(notionObject(run.text).link).url || run.href);
        const className = [
          marks.bold ? "font-semibold" : "",
          marks.italic ? "italic" : "",
          marks.underline ? "underline" : "",
          marks.strikethrough ? "line-through" : "",
          marks.code ? "rounded bg-muted px-1 font-mono" : "",
          run.type === "mention" ? "rounded bg-muted px-1" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const content = (
          <span className={className}>
            {text || `[${notionString(run.type) || "unsupported content"}]`}
          </span>
        );
        return link ? (
          <a
            key={index}
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-muted-foreground underline-offset-2"
          >
            {content}
          </a>
        ) : (
          <span key={index}>{content}</span>
        );
      })}
    </>
  );
}
export function NotionRichTextEditor({
  runs,
  onChange,
  disabled = false,
}: {
  runs: readonly unknown[];
  onChange: (runs: unknown[]) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const replace = (index: number, next: NotionObject) =>
    onChange(runs.map((run, position) => (position === index ? next : run)));
  const formats = [
    { key: "bold", text: "B", label: "Bold" },
    { key: "italic", text: "I", label: "Italic" },
    { key: "underline", text: "U", label: "Underline" },
    { key: "strikethrough", text: "S", label: "Strikethrough" },
    { key: "code", text: "</>", label: "Inline code" },
  ];
  return (
    <div className="space-y-3">
      {runs.map((raw, index) => {
        const run = notionObject(raw);
        const text = notionObject(run.text);
        const marks = notionObject(run.annotations);
        if ((run.type && run.type !== "text") || typeof text.content !== "string")
          return (
            <p key={index} className="rounded-lg bg-muted p-2 text-ui-sm">
              <NotionRichText runs={[raw]} />{" "}
              <span className="text-muted-foreground">· preserved read-only</span>
            </p>
          );
        return (
          <div key={index} className="space-y-2 rounded-lg border border-border p-2">
            <div
              role="group"
              aria-label={`Formatting for segment ${index + 1}`}
              className="flex flex-wrap gap-1"
            >
              {formats.map((format) => (
                <Button
                  key={format.key}
                  type="button"
                  size="sm"
                  variant={marks[format.key] ? "secondary" : "ghost"}
                  disabled={disabled}
                  aria-label={format.label}
                  aria-pressed={marks[format.key] === true}
                  onClick={() =>
                    replace(index, {
                      ...run,
                      annotations: { ...marks, [format.key]: marks[format.key] !== true },
                    })
                  }
                >
                  {format.text}
                </Button>
              ))}
            </div>
            <label htmlFor={`${prefix}-${index}`} className="sr-only">
              Text run {index + 1}
            </label>
            <Textarea
              id={`${prefix}-${index}`}
              aria-label={`Text run ${index + 1}`}
              value={text.content}
              rows={2}
              maxLength={2000}
              disabled={disabled}
              onChange={(event) =>
                replace(index, { ...run, text: { ...text, content: event.target.value } })
              }
            />
            <label className="grid gap-1 text-ui-sm text-muted-foreground">
              Link URL
              <Input
                aria-label={`Link for segment ${index + 1}`}
                value={notionString(notionObject(text.link).url)}
                disabled={disabled}
                placeholder="https://…"
                onChange={(event) =>
                  replace(index, {
                    ...run,
                    text: {
                      ...text,
                      link: event.target.value
                        ? { ...notionObject(text.link), url: event.target.value }
                        : null,
                    },
                  })
                }
              />
            </label>
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled || runs.length >= 100}
        onClick={() => onChange([...runs, { type: "text", text: { content: "" } }])}
      >
        {runs.length ? "Add text segment" : "Add text"}
      </Button>
    </div>
  );
}
