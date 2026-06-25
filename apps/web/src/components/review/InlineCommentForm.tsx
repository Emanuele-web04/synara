import { useCallback, useEffect, useRef, useState } from "react";

import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ReviewAvatar } from "./reviewPrPrimitives";
import { ReviewPill, reviewTextareaClassName } from "./reviewPrimitives";

export function InlineCommentForm(props: {
  initialBody?: string;
  busy?: boolean;
  saveLabel?: string;
  placeholder?: string;
  author?: {
    login: string;
    avatarUrl?: string | undefined;
  };
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(props.initialBody ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const trimmed = body.trim();
  const canSave = trimmed.length > 0 && !props.busy;
  const [tab, setTab] = useState<"write" | "preview">("write");

  const submit = useCallback(() => {
    if (trimmed.length === 0 || props.busy) return;
    props.onSave(trimmed);
  }, [props, trimmed]);

  return (
    <div className="flex flex-col gap-2">
      {props.author ? (
        <div className="flex min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground">
          <ReviewAvatar
            login={props.author.login}
            {...(props.author.avatarUrl !== undefined ? { avatarUrl: props.author.avatarUrl } : {})}
            className="size-4"
          />
          <span className="min-w-0 truncate font-medium text-foreground">{props.author.login}</span>
          <ReviewPill tone="warning">Pending</ReviewPill>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border/40 bg-background">
        <div className="flex h-8 items-center justify-between gap-2 border-b border-border/40 bg-muted/40 px-2">
          <div
            role="tablist"
            aria-label="Comment editor mode"
            className="flex items-center gap-0.5"
          >
            {(["write", "preview"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                onClick={() => setTab(entry)}
                className={cn(
                  "h-6 rounded-md px-2.5 text-[11px] font-medium capitalize outline-none transition-[background-color,color,transform] duration-150 motion-reduce:transition-none active:scale-[0.96] motion-reduce:active:scale-100",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  tab === entry
                    ? "bg-muted/60 text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
        {tab === "preview" ? (
          <div className="min-h-24 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            {trimmed.length > 0 ? (
              <p className="whitespace-pre-wrap break-words text-foreground">{trimmed}</p>
            ) : (
              "Nothing to preview."
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            aria-label="Inline review comment"
            value={body}
            disabled={props.busy}
            placeholder={props.placeholder ?? "Leave a comment..."}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancel();
                return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            className={cn(
              reviewTextareaClassName,
              "min-h-24 resize-y rounded-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0",
            )}
          />
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          disabled={!canSave}
          onClick={submit}
          className="rounded-md"
        >
          {props.busy ? <Loader2Icon className="size-3 animate-spin" /> : null}
          {props.saveLabel ?? "Save"}
        </Button>
      </div>
    </div>
  );
}
