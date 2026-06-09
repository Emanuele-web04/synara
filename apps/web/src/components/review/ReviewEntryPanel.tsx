import type { ReviewSourceRef } from "@t3tools/contracts";
import { useState } from "react";

import { parsePullRequestReference } from "~/pullRequestReference";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { BranchComparePicker } from "./BranchComparePicker";
import { PullRequestList } from "./PullRequestList";

function PanelSection(props: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-border/60 pb-5 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-[13px] text-foreground">{props.title}</h2>
        {props.description ? (
          <p className="text-pretty text-[11px] text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

export function ReviewEntryPanel(props: {
  mode?: "page" | "dock";
  cwd: string | null;
  onSelectSource: (source: ReviewSourceRef) => void;
}) {
  const dense = props.mode === "dock";
  const [referenceInput, setReferenceInput] = useState("");
  const [referenceDirty, setReferenceDirty] = useState(false);

  const parsedReference = parsePullRequestReference(referenceInput);

  const loadReference = () => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    props.onSelectSource({ _tag: "pullRequest", reference: parsedReference });
  };

  const validationMessage =
    referenceDirty && parsedReference === null
      ? referenceInput.trim().length === 0
        ? "Paste a GitHub pull request URL or enter 123 / #123."
        : "Use a GitHub pull request URL, 123, or #123."
      : null;

  if (props.cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        Add a project to review a pull request.
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div
        className={cn(
          "mx-auto flex w-full max-w-2xl flex-col px-4",
          dense ? "gap-4 py-4" : "gap-6 py-6",
        )}
      >
        <PanelSection
          title="Pull requests"
          description="Open by reference, or choose from the repository list."
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                placeholder="https://github.com/owner/repo/pull/42 or #42"
                aria-invalid={validationMessage !== null}
                value={referenceInput}
                onChange={(event) => {
                  setReferenceDirty(true);
                  setReferenceInput(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  loadReference();
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-md"
                onClick={loadReference}
              >
                Load
              </Button>
            </div>
            {validationMessage ? (
              <p role="alert" className="text-[11px] text-destructive">
                {validationMessage}
              </p>
            ) : null}
          </div>
          <PullRequestList cwd={props.cwd} onSelectSource={props.onSelectSource} />
        </PanelSection>

        <PanelSection
          title="Compare branches"
          description="Review a local diff without a pull request."
        >
          <BranchComparePicker cwd={props.cwd} onSelectSource={props.onSelectSource} />
        </PanelSection>
      </div>
    </ScrollArea>
  );
}
