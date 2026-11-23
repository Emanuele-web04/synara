// FILE: content.ts
// Purpose: The app tour's steps: which control each step points at and what it says.
// Layer: Web UI constants (no React)
// Exports: APP_TOUR_STEPS, APP_TOUR_ANCHOR_ATTRIBUTE, AppTourStep, AppTourStepId

/** Put on the control a step points at: `data-app-tour="<anchor>"`. */
export const APP_TOUR_ANCHOR_ATTRIBUTE = "data-app-tour";

export type AppTourStepId = "newThread" | "activity" | "tasks" | "inbox" | "pullRequests";

export interface AppTourStep {
  readonly id: AppTourStepId;
  /** Matches the control's `data-app-tour` value; the rail and the panel share item ids. */
  readonly anchor: string;
  /** Names the place in the app, shown above the title ("2 of 5 · Activity"). */
  readonly placeKey: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
}

// A walk around the workspace, in the order the eye finds things: start a chat, watch it
// in Activity, then the rail's Tasks, Inbox and Code review. Keep it about where things
// live, not a feature inventory.
export const APP_TOUR_STEPS: readonly AppTourStep[] = [
  {
    id: "newThread",
    anchor: "newThread",
    placeKey: "chat:sections_newThread",
    titleKey: "onboarding:appTourNewChatTitle",
    descriptionKey: "onboarding:appTourNewChatDescription",
  },
  {
    id: "activity",
    anchor: "activity",
    placeKey: "workspace:profile_activity",
    titleKey: "onboarding:appTourActivityTitle",
    descriptionKey: "workspace:seeRunningTasksCompletedWorkAndAnythingThatNeeds",
  },
  {
    id: "tasks",
    anchor: "tasks",
    placeKey: "chat:tasks",
    titleKey: "onboarding:appTourTasksTitle",
    descriptionKey: "common:keepYourToDosInOnePlaceAndHand",
  },
  {
    id: "inbox",
    anchor: "inbox",
    placeKey: "workspace:inbox",
    titleKey: "onboarding:appTourInboxTitle",
    descriptionKey: "onboarding:appTourInboxDescription",
  },
  {
    id: "pullRequests",
    anchor: "pullRequests",
    placeKey: "workspace:codeReview",
    titleKey: "onboarding:appTourReviewTitle",
    descriptionKey: "onboarding:appTourReviewDescription",
  },
];
