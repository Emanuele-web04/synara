export const AUTOMATION_NAME_AUTHORING_GUIDANCE =
  'Choose a concise, specific 3–8 word outcome-oriented task label. Preserve the target identifier, omit cadence, and never use a generic label by itself (for example, "Automation", "Monitor", or "Check status"). Example: "Watch PR 142 CI".';

export const AUTOMATION_PROMPT_AUTHORING_GUIDANCE =
  "Write a self-contained brief for a future run with no assumed chat context. Include the objective, exact scope, relevant identifiers, paths, or URLs, required checks or actions, and explicit criteria for notifying the user versus staying silent. Do not repeat the schedule in the prompt.";

export const AUTOMATION_AUTHORING_GUIDANCE = `${AUTOMATION_NAME_AUTHORING_GUIDANCE} ${AUTOMATION_PROMPT_AUTHORING_GUIDANCE}`;
