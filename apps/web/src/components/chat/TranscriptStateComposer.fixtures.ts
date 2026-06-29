import { ApprovalRequestId } from "@t3tools/contracts";

import type { PendingApproval, PendingUserInput } from "../../session-logic";

const LAB_CREATED_AT = "2026-06-29T18:12:05.000Z";

export const LAB_APPROVAL_REQUEST_ID = ApprovalRequestId.makeUnsafe("transcript-lab-approval");
export const LAB_USER_INPUT_REQUEST_ID = ApprovalRequestId.makeUnsafe(
  "transcript-lab-user-input",
);

export const LAB_PENDING_APPROVAL: PendingApproval = {
  requestId: LAB_APPROVAL_REQUEST_ID,
  requestKind: "command",
  createdAt: LAB_CREATED_AT,
  detail:
    'exec_command: {"command":"bun run typecheck","cwd":"/Users/tylersheffield/code/synara"}',
};

export const LAB_PENDING_USER_INPUT: PendingUserInput = {
  requestId: LAB_USER_INPUT_REQUEST_ID,
  createdAt: LAB_CREATED_AT,
  questions: [
    {
      id: "wait-treatment",
      header: "WAIT",
      question: "How should Synara hold the composer while the agent has no text yet?",
      options: [
        {
          label: "Keep it compact",
          description: "Show a calm blocked composer with precise status.",
        },
        {
          label: "Surface activity",
          description: "Let reasoning and tools prove the turn is alive.",
        },
        {
          label: "Ask for action",
          description: "Transform into approval or input when blocked.",
        },
      ],
    },
    {
      id: "states-covered",
      header: "STATES",
      question: "Which blocker states should share this composer treatment?",
      multiSelect: true,
      options: [
        {
          label: "Slow startup",
          description: "The server accepted the turn, but no token exists.",
        },
        {
          label: "Tool first",
          description: "Tools run before assistant prose appears.",
        },
        {
          label: "Approval and input",
          description: "The turn is paused on an explicit user decision.",
        },
      ],
    },
  ],
};

export const LAB_PENDING_USER_INPUTS: PendingUserInput[] = [LAB_PENDING_USER_INPUT];

export const EMPTY_USER_INPUT_REQUEST_IDS: ApprovalRequestId[] = [];
export const RESPONDING_USER_INPUT_REQUEST_IDS: ApprovalRequestId[] = [
  LAB_USER_INPUT_REQUEST_ID,
];
