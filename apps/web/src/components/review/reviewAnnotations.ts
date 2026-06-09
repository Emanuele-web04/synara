import type { AnnotationSide } from "@pierre/diffs";
import type {
  ReviewCommentSide,
  ReviewFinding,
  ReviewLocalComment,
  ReviewRemoteThread,
} from "@t3tools/contracts";
import type { ReviewDraftComment } from "~/reviewStore.logic";

export interface ReviewLocalDraftAnnotation {
  kind: "local-draft";
  path: string;
  line: number;
  side: ReviewCommentSide;
  comments: ReadonlyArray<ReviewLocalComment>;
  draft: ReviewDraftComment | null;
}

export interface ReviewSubmittedThreadAnnotation {
  kind: "submitted-thread";
  path: string;
  line: number;
  side: ReviewCommentSide;
  thread: ReviewRemoteThread;
}

export interface ReviewAgentFindingAnnotation {
  kind: "agent-finding";
  path: string;
  line: number;
  side: ReviewCommentSide;
  finding: ReviewFinding;
}

export type ReviewLineAnnotationData =
  | ReviewLocalDraftAnnotation
  | ReviewSubmittedThreadAnnotation
  | ReviewAgentFindingAnnotation;

// @pierre/diffs anchors annotations on its own side naming; map the GitHub
// LEFT/RIGHT contract sides onto it (LEFT = old/deletions, RIGHT = new/additions).
export function toAnnotationSide(side: ReviewCommentSide): AnnotationSide {
  return side === "LEFT" ? "deletions" : "additions";
}

export function fromAnnotationSide(side: AnnotationSide): ReviewCommentSide {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

export function annotationAnchorKey(path: string, line: number, side: ReviewCommentSide): string {
  return `${path} ${line} ${side}`;
}
