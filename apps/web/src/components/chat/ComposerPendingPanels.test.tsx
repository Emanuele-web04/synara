import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

describe("composer pending panels", () => {
  it("describes approval actions with the active blocker status", () => {
    const requestId = ApprovalRequestId.makeUnsafe("approval-a11y");
    const panelMarkup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId,
          requestKind: "command",
          createdAt: "2026-03-17T19:12:28.000Z",
          detail: 'shell: {"command":"bun run test"}',
        }}
        pendingCount={1}
      />,
    );
    const actionsMarkup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        describedById="pending-approval-status-approval-a11y"
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(panelMarkup).toContain('role="group"');
    expect(panelMarkup).toContain('id="pending-approval-status-approval-a11y"');
    expect(actionsMarkup).toContain('aria-describedby="pending-approval-status-approval-a11y"');
  });

  it("exposes pending user input option selection state", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: ApprovalRequestId.makeUnsafe("user-input-a11y"),
            createdAt: "2026-03-17T19:12:28.000Z",
            questions: [
              {
                id: "question-1",
                header: "Mode",
                question: "Choose a mode",
                multiSelect: true,
                options: [
                  { label: "Fast", description: "Move quickly" },
                  { label: "Careful", description: "Check details" },
                ],
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{ "question-1": { selectedOptionLabels: ["Careful"] } }}
        questionIndex={0}
        onToggleOption={() => null}
        onAdvance={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-describedby="pending-user-input-status-user-input-a11y"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-pressed="true"');
  });
});
