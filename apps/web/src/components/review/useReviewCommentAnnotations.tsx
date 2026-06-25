import type { DiffLineAnnotation } from "@pierre/diffs";
import type {
  ReviewFinding,
  ReviewLocalComment,
  ReviewRemoteThread,
  ReviewTargetKey,
  ReviewViewerResult,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import {
  reviewAddCommentMutationOptions,
  reviewDeleteThreadCommentMutationOptions,
  reviewListCommentsQueryOptions,
  reviewLoadRemoteThreadsQueryOptions,
  reviewReplyThreadMutationOptions,
  reviewResolveThreadMutationOptions,
  reviewRemoveCommentMutationOptions,
  reviewUpdateCommentMutationOptions,
  reviewUpdateThreadCommentMutationOptions,
  reviewViewerQueryOptions,
} from "~/lib/reviewReactQuery";
import { selectReviewAgentFindings, selectReviewDrafts, useReviewStore } from "~/reviewStore";
import { type ReviewDraftComment, reviewTargetKeyString } from "~/reviewStore.logic";
import type { ReviewCommentThreadActions } from "./ReviewCommentThread";
import type { ReviewDraftAnchor } from "./ReviewFileDiffBlock";
import {
  annotationAnchorKey,
  type ReviewLineAnnotationData,
  toAnnotationSide,
} from "./reviewAnnotations";

type FileAnnotationMap = Map<string, DiffLineAnnotation<ReviewLineAnnotationData>[]>;

export interface ReviewCommentAnnotationTools {
  readonly annotationsByFile: ReadonlyMap<
    string,
    ReadonlyArray<DiffLineAnnotation<ReviewLineAnnotationData>>
  >;
  readonly commentsEnabled: boolean;
  readonly startDraft: (anchor: ReviewDraftAnchor) => void;
  readonly threadActions: ReviewCommentThreadActions;
  readonly viewer: ReviewViewerResult | null;
  readonly viewerIdentity: string;
}

export function useReviewCommentAnnotations(input: {
  target: ReviewTargetKey | null;
  cwd: string | null;
  reference: string | null;
  patchSignature?: string | null;
  headSha?: string | null;
}): ReviewCommentAnnotationTools {
  const queryClient = useQueryClient();
  const target = input.target;
  const targetKey = target ? reviewTargetKeyString(target) : null;
  const commentsEnabled = target !== null;
  const viewerQuery = useQuery(
    reviewViewerQueryOptions({ cwd: commentsEnabled ? input.cwd : null }),
  );
  const commentsQuery = useQuery(reviewListCommentsQueryOptions({ target }));
  const remoteThreadsEnabled = target?._tag === "pullRequest";
  const remoteThreadsQuery = useQuery(
    reviewLoadRemoteThreadsQueryOptions({
      cwd: remoteThreadsEnabled ? input.cwd : null,
      reference: remoteThreadsEnabled ? input.reference : null,
    }),
  );
  const drafts = useReviewStore(selectReviewDrafts(targetKey ?? "none"));
  const agentFindings = useReviewStore(
    selectReviewAgentFindings(target, input.patchSignature ?? null, input.headSha ?? null),
  );
  const beginDraft = useReviewStore((store) => store.beginDraft);
  const editDraft = useReviewStore((store) => store.editDraft);
  const discardDraft = useReviewStore((store) => store.discardDraft);
  const reconcile = useReviewStore((store) => store.reconcile);
  const dismissFinding = useReviewStore((store) => store.dismissFinding);

  const addCommentMutation = useMutation(reviewAddCommentMutationOptions({ queryClient }));
  const updateCommentMutation = useMutation(reviewUpdateCommentMutationOptions({ queryClient }));
  const removeCommentMutation = useMutation(reviewRemoveCommentMutationOptions({ queryClient }));
  const resolveThreadMutation = useMutation(
    reviewResolveThreadMutationOptions({
      queryClient,
      cwd: input.cwd,
      reference: input.reference,
    }),
  );
  const replyThreadMutation = useMutation(
    reviewReplyThreadMutationOptions({
      queryClient,
      cwd: input.cwd,
      reference: input.reference,
    }),
  );
  const updateThreadCommentMutation = useMutation(
    reviewUpdateThreadCommentMutationOptions({
      queryClient,
      cwd: input.cwd,
      reference: input.reference,
    }),
  );
  const deleteThreadCommentMutation = useMutation(
    reviewDeleteThreadCommentMutationOptions({
      queryClient,
      cwd: input.cwd,
      reference: input.reference,
    }),
  );

  const serverComments = commentsQuery.data?.comments;
  const remoteThreads = remoteThreadsQuery.data?.threads;

  useEffect(() => {
    if (target && serverComments) {
      reconcile(target, serverComments);
    }
  }, [target, serverComments, reconcile]);

  const annotationsByFile = useMemo(
    () => buildAnnotationsByFile(serverComments ?? [], drafts, remoteThreads ?? [], agentFindings),
    [serverComments, drafts, remoteThreads, agentFindings],
  );

  const startDraft = useCallback(
    (anchor: ReviewDraftAnchor) => {
      if (!target) return;
      beginDraft({ target, path: anchor.path, line: anchor.line, side: anchor.side });
    },
    [target, beginDraft],
  );

  const threadActions = useMemo<ReviewCommentThreadActions>(
    () => ({
      saveDraft: (draftId, body) => {
        if (!target) return;
        const draft = drafts.find((entry) => entry.draftId === draftId);
        if (!draft) return;
        editDraft(target, draftId, { body, status: "saving" });
        addCommentMutation.mutate(
          {
            target,
            path: draft.path,
            line: draft.line,
            side: draft.side,
            body,
            ...(draft.threadId ? { threadId: draft.threadId } : {}),
          },
          {
            onSuccess: () => discardDraft(target, draftId),
            onError: () => editDraft(target, draftId, { status: "editing" }),
          },
        );
      },
      cancelDraft: (draftId) => {
        if (target) discardDraft(target, draftId);
      },
      updateBody: (comment, body) => {
        if (target) updateCommentMutation.mutate({ target, id: comment.id, body });
      },
      toggleResolved: (comment) => {
        if (target) {
          updateCommentMutation.mutate({ target, id: comment.id, resolved: !comment.resolved });
        }
      },
      remove: (comment) => {
        if (target) removeCommentMutation.mutate({ target, id: comment.id });
      },
      startReply: (data) => {
        if (!target) return;
        const threadId = data.comments.at(0)?.threadId ?? null;
        beginDraft({ target, path: data.path, line: data.line, side: data.side, threadId });
      },
      convertFinding: (finding) => {
        if (!target) return;
        if (
          findingAlreadyCommented({
            finding,
            comments: serverComments ?? [],
            drafts,
            remoteThreads: remoteThreads ?? [],
          })
        ) {
          dismissFinding(target, finding);
          return;
        }
        addCommentMutation.mutate(
          {
            target,
            path: finding.path,
            line: finding.line,
            side: finding.side,
            body: formatFindingBody(finding),
          },
          { onSuccess: () => dismissFinding(target, finding) },
        );
      },
      dismissFinding: (finding) => {
        if (target) dismissFinding(target, finding);
      },
      resolveRemoteThread: (thread, resolved) => {
        resolveThreadMutation.mutate({ threadId: thread.id, resolved });
      },
      replyRemoteThread: (thread, body) => {
        replyThreadMutation.mutate({ threadId: thread.id, body });
      },
      editRemoteComment: (commentId, body) => {
        updateThreadCommentMutation.mutate({ commentId, body });
      },
      deleteRemoteComment: (commentId) => {
        deleteThreadCommentMutation.mutate({ commentId });
      },
    }),
    [
      target,
      drafts,
      serverComments,
      remoteThreads,
      editDraft,
      discardDraft,
      beginDraft,
      addCommentMutation,
      updateCommentMutation,
      removeCommentMutation,
      resolveThreadMutation,
      replyThreadMutation,
      updateThreadCommentMutation,
      deleteThreadCommentMutation,
      dismissFinding,
    ],
  );

  const viewer = viewerQuery.data ?? null;
  const viewerIdentity = useMemo(
    () => (viewer ? `${viewer.login}:${viewer.avatarUrl ?? ""}` : "viewer-pending"),
    [viewer],
  );

  return {
    annotationsByFile,
    commentsEnabled,
    startDraft,
    threadActions,
    viewer,
    viewerIdentity,
  };
}

function pushFileAnnotation(
  byFile: FileAnnotationMap,
  path: string,
  annotation: DiffLineAnnotation<ReviewLineAnnotationData>,
): void {
  const fileList = byFile.get(path);
  if (fileList) {
    fileList.push(annotation);
  } else {
    byFile.set(path, [annotation]);
  }
}

function formatFindingBody(finding: ReviewFinding): string {
  return `${finding.title}\n\n${finding.message}`;
}

function normalizeCommentBody(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function findingAlreadyCommented(input: {
  readonly finding: ReviewFinding;
  readonly comments: ReadonlyArray<ReviewLocalComment>;
  readonly drafts: ReadonlyArray<ReviewDraftComment>;
  readonly remoteThreads: ReadonlyArray<ReviewRemoteThread>;
}): boolean {
  const anchor = annotationAnchorKey(input.finding.path, input.finding.line, input.finding.side);
  const findingBody = normalizeCommentBody(formatFindingBody(input.finding));
  const findingMessage = normalizeCommentBody(input.finding.message);
  const matchesBody = (body: string): boolean => {
    const normalized = normalizeCommentBody(body);
    return normalized === findingBody || normalized.includes(findingMessage);
  };
  return (
    input.comments.some(
      (comment) =>
        annotationAnchorKey(comment.path, comment.line, comment.side) === anchor &&
        matchesBody(comment.body),
    ) ||
    input.drafts.some(
      (draft) =>
        annotationAnchorKey(draft.path, draft.line, draft.side) === anchor &&
        matchesBody(draft.body),
    ) ||
    input.remoteThreads.some((thread) => {
      const side = thread.side ?? "RIGHT";
      return (
        thread.path !== undefined &&
        thread.line !== undefined &&
        annotationAnchorKey(thread.path, thread.line, side) === anchor &&
        thread.comments.some((comment) => matchesBody(comment.body))
      );
    })
  );
}

function buildAnnotationsByFile(
  comments: ReadonlyArray<ReviewLocalComment>,
  drafts: ReadonlyArray<ReviewDraftComment>,
  remoteThreads: ReadonlyArray<ReviewRemoteThread>,
  agentFindings: ReadonlyArray<ReviewFinding>,
): FileAnnotationMap {
  const grouped = new Map<
    string,
    {
      path: string;
      line: number;
      side: ReviewLocalComment["side"];
      comments: ReviewLocalComment[];
    }
  >();

  for (const comment of comments) {
    const key = annotationAnchorKey(comment.path, comment.line, comment.side);
    const existing = grouped.get(key);
    if (existing) {
      existing.comments.push(comment);
    } else {
      grouped.set(key, {
        path: comment.path,
        line: comment.line,
        side: comment.side,
        comments: [comment],
      });
    }
  }

  const draftByKey = new Map<string, ReviewDraftComment>();
  for (const draft of drafts) {
    const key = annotationAnchorKey(draft.path, draft.line, draft.side);
    draftByKey.set(key, draft);
    if (!grouped.has(key)) {
      grouped.set(key, { path: draft.path, line: draft.line, side: draft.side, comments: [] });
    }
  }

  const byFile: FileAnnotationMap = new Map();
  for (const [key, entry] of grouped) {
    const sortedComments = entry.comments.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const draft = draftByKey.get(key) ?? null;
    const data: ReviewLineAnnotationData = {
      kind: "local-draft",
      path: entry.path,
      line: entry.line,
      side: entry.side,
      comments: sortedComments,
      draft,
    };
    pushFileAnnotation(byFile, entry.path, {
      side: toAnnotationSide(entry.side),
      lineNumber: entry.line,
      metadata: data,
    });
  }

  for (const thread of remoteThreads) {
    if (!thread.path || thread.line === undefined) {
      continue;
    }
    const side = thread.side ?? "RIGHT";
    pushFileAnnotation(byFile, thread.path, {
      side: toAnnotationSide(side),
      lineNumber: thread.line,
      metadata: { kind: "submitted-thread", path: thread.path, line: thread.line, side, thread },
    });
  }

  for (const finding of agentFindings) {
    pushFileAnnotation(byFile, finding.path, {
      side: toAnnotationSide(finding.side),
      lineNumber: finding.line,
      metadata: {
        kind: "agent-finding",
        path: finding.path,
        line: finding.line,
        side: finding.side,
        finding,
      },
    });
  }
  return byFile;
}
