// FILE: petModel.ts
// Purpose: Defines Codex pet sprite metadata and derives lightweight pet animation state.
// Layer: Global pet overlay domain helpers
// Exports: pet constants, manifest types, and animation resolution

export const PET_COLUMNS = 8;
export const PET_ROWS = 9;
// Source tile is 192x208; render at exact half so pixel-art upscaling stays crisp and never sub-pixel clips.
export const PET_RENDER_WIDTH = 96;
export const PET_RENDER_HEIGHT = 104;

export const PET_STATE_ROWS = {
  idle: { row: 0, frames: 1, durationMs: 180 },
  runningRight: { row: 1, frames: 8, durationMs: 120 },
  runningLeft: { row: 2, frames: 8, durationMs: 120 },
  waving: { row: 3, frames: 4, durationMs: 150 },
  jumping: { row: 4, frames: 5, durationMs: 140 },
  failed: { row: 5, frames: 8, durationMs: 150 },
  waiting: { row: 6, frames: 6, durationMs: 170 },
  running: { row: 7, frames: 6, durationMs: 130 },
  review: { row: 8, frames: 6, durationMs: 155 },
} as const;

export type CodexPetAnimation = keyof typeof PET_STATE_ROWS;
export type CodexPetAnimationSpec = (typeof PET_STATE_ROWS)[CodexPetAnimation];

export interface CodexPetManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly spritesheetUrl: string;
}

export interface CodexPetThreadStateInput {
  readonly archivedAt?: string | null;
  readonly sessionStatus: string | null;
  readonly orchestrationStatus?: string | null;
  readonly latestTurnState: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly hasLiveTailWork?: boolean;
  readonly error: string | null;
}

// Resolves durable thread state into a pet pose; transient celebration stays in the UI layer.
export function resolvePetAnimation(input: CodexPetThreadStateInput): CodexPetAnimation {
  if (input.archivedAt != null) {
    return "idle";
  }
  if (input.error || input.latestTurnState === "error" || input.sessionStatus === "error") {
    return "idle";
  }
  if (input.hasPendingApprovals || input.hasPendingUserInput) {
    return "waiting";
  }
  if (
    input.hasLiveTailWork ||
    input.latestTurnState === "running" ||
    input.sessionStatus === "running" ||
    input.orchestrationStatus === "running" ||
    input.orchestrationStatus === "starting"
  ) {
    return "idle";
  }
  if (input.sessionStatus === "starting" || input.sessionStatus === "connecting") {
    return "idle";
  }
  if (input.hasActionableProposedPlan) {
    return "review";
  }
  return "idle";
}

// Folds all chats into one pet pose so background work is visible outside the focused thread.
export function resolveGlobalPetAnimation(
  threads: readonly CodexPetThreadStateInput[],
): CodexPetAnimation {
  let hasReview = false;

  for (const thread of threads) {
    const animation = resolvePetAnimation(thread);
    if (animation === "waiting") return "waiting";
    hasReview ||= animation === "review";
  }

  if (hasReview) return "review";
  return "idle";
}

// Distinguishes durable state animations from one-shot reactions so gestures never loop forever.
export function shouldLoopPetAnimation(animation: CodexPetAnimation): boolean {
  return animation !== "jumping" && animation !== "waving";
}
