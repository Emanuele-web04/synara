// FILE: PendingCards.tsx
// Purpose: What the bot's thread waits on the user for, as HoloBot's ask cards at its end: a
//          pending tool approval as a choice card (Approve once, Always allow, Decline, Cancel
//          the turn) answered through Synara's respondToThreadApproval, and a pending question
//          (`ask_user`) as HoloBot's QuestionCard: a page per question, lettered answers (one to
//          pick, or several: "Choose all that apply" then Next or Done), Back between pages,
//          dots for where it is, × to skip them all; Synara's composer answers in words instead.
//          Both run on ChatView's own pending interactions (its transcript slot input).
// Layer: SynBot thread UI
// Exports: ApprovalCard, QuestionCard

import type { ProviderApprovalDecision } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useRef } from "react";

import { useTranslation } from "~/i18n";
import type { PendingApproval } from "~/session-logic";

import { CapsuleButton, IconButton } from "../kit/controls";
import { ChoiceRows, InlineText, Pair, type ChoiceRow } from "./ChoiceParts";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";

const KIND_PROMPT: Record<PendingApproval["requestKind"], string> = {
  command: "chat:approvalActions_promptCommand",
  "file-read": "chat:approvalActions_promptFileRead",
  "file-change": "chat:approvalActions_promptFileChange",
  permissions: "chat:grantThesePermissions",
  tool: "chat:approveThisToolCall",
};

const ACTIONS: ReadonlyArray<{
  readonly decision: ProviderApprovalDecision;
  readonly labelKey: string;
}> = [
  { decision: "accept", labelKey: "chat:approvalActions_approveOnce" },
  { decision: "acceptForSession", labelKey: "chat:approvalActions_alwaysAllow" },
  { decision: "decline", labelKey: "chat:approvalActions_decline" },
  { decision: "cancel", labelKey: "chat:approvalActions_cancelTurn" },
];

export function ApprovalCard({
  approval,
  pending,
}: {
  readonly approval: PendingApproval;
  readonly pending: ChatTranscriptSlotInput;
}) {
  const { t } = useTranslation();
  const key = pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration);
  const responding = pending.respondingRequestKeys.includes(key);
  // One answer per request attempt, also when a key and a click race.
  const sent = useRef<string | null>(null);
  const attempt = JSON.stringify([key, approval.responseAttemptKey ?? null]);
  const actions = ACTIONS.filter(
    (action) =>
      action.decision !== "acceptForSession" ||
      (approval.sessionApprovalAvailable !== false && approval.approvalScope === undefined),
  );
  const rows: ChoiceRow[] = actions.map((action) => ({
    id: action.decision,
    label: t(action.labelKey),
    primary: action.decision === "accept",
    danger: action.decision === "decline",
  }));
  const respond = (row: ChoiceRow) => {
    if (responding || sent.current === attempt) return;
    sent.current = attempt;
    void pending
      .onRespondToApproval(
        approval.requestId,
        row.id as ProviderApprovalDecision,
        approval.lifecycleGeneration,
        approval.requestKind,
      )
      .catch(() => {
        if (sent.current === attempt) sent.current = null;
      });
  };
  return (
    <div className="choice">
      <div className="choice__head">
        <p className="choice__title">
          {t(KIND_PROMPT[approval.requestKind])}
          {approval.toolName ? ` · ${approval.toolName}` : ""}
        </p>
      </div>
      {approval.detail ? <pre className="choice__detail">{approval.detail}</pre> : null}
      <ChoiceRows rows={rows} open disabled={responding} onPick={respond} />
    </div>
  );
}

export function QuestionCard({
  pending,
}: {
  readonly pending: ChatTranscriptSlotInput["pendingUserInput"];
}) {
  const { t } = useTranslation();
  const { input, progress, question } = pending;
  if (!input || !progress || !question) return null;
  const sending = pending.isResponding;
  const count = input.questions.length;
  const page = progress.questionIndex;
  const paged = count > 1;
  const picked = new Set(progress.selectedOptionLabels);
  const choose = (row: ChoiceRow) => {
    if (sending) return;
    if (question.multiSelect) {
      pending.onToggleOption(question.id, row.id);
      return;
    }
    // One answer to pick: the click is the answer (and moves on).
    pending.onAdvance({ [question.id]: { selectedOptionLabels: [row.id] } });
  };
  const rows: ChoiceRow[] = question.options.map((option) => ({
    id: option.label,
    label: option.label,
    picked: picked.has(option.label),
  }));
  const skipAll = () => pending.onCancel();
  // One question with two answers: the question and two small buttons.
  if (!paged && !question.multiSelect && question.options.length === 2) {
    return (
      <>
        <div className="choice choice--pair">
          <div className="choice__head">
            <p className="choice__title">
              <InlineText text={question.question} />
            </p>
            <IconButton
              icon="close"
              kind="ghost"
              className="choice__close"
              label={t("synbot:skipQuestions")}
              disabled={sending}
              onClick={skipAll}
            />
          </div>
          <Pair buttons={rows} disabled={sending} onPick={choose} />
        </div>
        <p className="choice__aside">{t("synbot:orAnswerInChat")}</p>
      </>
    );
  }
  const footer = paged || question.multiSelect;
  return (
    <>
      <div className="choice">
        <div className="choice__head">
          <p className="choice__title">
            <InlineText text={question.question} />
          </p>
          <IconButton
            icon="close"
            kind="ghost"
            className="choice__close"
            label={t("synbot:skipQuestions")}
            disabled={sending}
            onClick={skipAll}
          />
        </div>
        {question.multiSelect ? <p className="choice__hint">{t("synbot:chooseAll")}</p> : null}
        <ChoiceRows rows={rows} open disabled={sending} label={question.question} onPick={choose} />
        {footer ? (
          <div className="choice__foot">
            {paged ? (
              <span
                className="choice__dots"
                aria-label={t("synbot:questionPage", { page: page + 1, count })}
              >
                {input.questions.map((entry, index) => (
                  <span
                    key={entry.id}
                    className="choice__dot"
                    data-on={index === page || undefined}
                  />
                ))}
              </span>
            ) : null}
            {page > 0 ? (
              <CapsuleButton
                kind="normal"
                small
                disabled={sending}
                onClick={() => pending.onPrevious()}
              >
                {t("synbot:back")}
              </CapsuleButton>
            ) : null}
            {question.multiSelect || paged ? (
              <CapsuleButton
                kind="primary"
                small
                disabled={sending || !progress.canAdvance}
                onClick={() => pending.onAdvance()}
              >
                {progress.isLastQuestion ? t("synbot:done") : t("synbot:next")}
              </CapsuleButton>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="choice__aside">{t("synbot:orAnswerInChat")}</p>
    </>
  );
}
