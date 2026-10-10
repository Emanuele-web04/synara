// FILE: PullRequestCommentComposer.tsx
// Purpose: Inline "Leave a comment" pill at the bottom of a GitHub item's Comments section. Posts
//          through the comment mutation its host passes in (pull request or issue), as the
//          authenticated GitHub user (hence the GitHub glyph in the leading slot); the mutation
//          owns revalidating the detail and the lists. Enter submits; Shift+Enter breaks a line
//          (comments accept markdown).
// Layer: Pull request presentation
// Exports: PullRequestCommentComposer, GitHubCommentTarget, GitHubCommentMutation

import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import type { PullRequestDetailInput } from "@synara/contracts";
import { useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { ArrowUpIcon, GitHubIcon } from "~/lib/icons";
import { PR_BODY_TEXT_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";

/** The item a comment goes to. Pull requests and issues share one number space per repository. */
export type GitHubCommentTarget = Pick<
  PullRequestDetailInput,
  "projectId" | "repository" | "number"
>;

/** The slice of a React Query comment mutation the composer drives. */
export interface GitHubCommentMutation {
  mutateAsync: (input: GitHubCommentTarget & { body: string }) => Promise<unknown>;
  isPending: boolean;
}

export function PullRequestCommentComposer({
  target,
  mutation,
}: {
  target: GitHubCommentTarget;
  mutation: GitHubCommentMutation;
}) {
  const [body, setBody] = useState("");
  // synchronous re-entrancy lock: mutation.isPending updates on React's schedule, too late to stop a rapid double Enter posting twice
  const submittingRef = useRef(false);
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !mutation.isPending;

  // promise chain instead of async/try-finally: React Compiler doesn't support try/finally
  const submit = () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    void mutation
      .mutateAsync({
        projectId: target.projectId,
        repository: target.repository,
        number: target.number,
        body: trimmed,
      })
      .then(() => {
        setBody("");
      })
      .catch((error: unknown) => {
        // The draft stays in the field on failure — nothing to re-type.
        toastManager.add({
          type: "error",
          title: "Could not post comment",
          description: error instanceof Error ? error.message : "GitHub CLI comment failed.",
        });
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <div
      className={`${GLASS_RAISED_SURFACE_CLASS_NAME} flex items-center gap-2 rounded-3xl border border-border/60 bg-background py-1 pl-3 pr-1.5 shadow-sm`}
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-muted-foreground"
        title="Commenting as your GitHub account"
      >
        <GitHubIcon className="size-3" />
      </span>
      <textarea
        rows={Math.min(6, body.split("\n").length)}
        value={body}
        disabled={mutation.isPending}
        placeholder="Leave a comment"
        aria-label="Leave a comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Enter during IME composition confirms the composition, not the comment.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        // font-system-ui overrides the global `textarea { font-family: mono }` reset — UI chrome, not code
        className={cn(
          PR_BODY_TEXT_CLASS_NAME,
          "font-system-ui min-w-0 flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-60",
        )}
      />
      <button
        type="button"
        disabled={!canSubmit}
        aria-label="Post comment"
        title="Post comment"
        onClick={() => void submit()}
        className="flex size-7 shrink-0 items-center justify-center self-end rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-35"
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
