// FILE: PendingCards.tsx
// Purpose: What the bot's thread waits on the user for, as HoloBot's ask cards at its end: a
//          pending tool approval as a choice card answered through respondToThreadApproval, with
//          Synara's own approval panel's wording, Computer scopes, answers and parsed request
//          (the file, the command, the tool's parameters), and "1/3" when more wait; and a
//          pending question (`ask_user`) as HoloBot's QuestionCard: a page per question,
//          lettered answers with their descriptions (one to pick, or several: "Choose all that
//          apply" then Next or Done), Back between pages, dots for where it is, × to skip them
//          all; Synara's composer answers in words instead. Both run on ChatView's own pending
//          interactions (its transcript slot input). Their letters answer only while the card
//          has focus.
// Layer: SynBot thread UI
// Exports: ApprovalCard, QuestionCard

import type { ProviderApprovalDecision } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useRef } from "react";

import { useTranslation } from "~/i18n";
import type { PendingApproval } from "~/session-logic";

import { CapsuleButton, IconButton } from "../kit/controls";
import { letterKeyHandler } from "./cardKeys";
import { ChoiceRows, InlineText, Pair, type ChoiceRow } from "./ChoiceParts";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";
import {
  ApprovalDetail,
  approvalActionsFor,
  approvalPromptKey,
  parseApprovalDetail,
} from "../../chat/ComposerPendingApprovalPanel";

export function ApprovalCard({
  approval,
  pendingCount,
  pending,
}: {
  readonly approval: PendingApproval;
  /** How many approvals wait (this one is the first). */
  readonly pendingCount: number;
  readonly pending: ChatTranscriptSlotInput;
}) {
  const { t } = useTranslation();
  const key = pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration);
  const responding = pending.respondingRequestKeys.includes(key);
  // One answer per request attempt, also when a key and a click race.
  const sent = useRef<string | null>(null);
  const attempt = JSON.stringify([key, approval.responseAttemptKey ?? null]);
  const parsed = parseApprovalDetail(approval.detail);
  const toolName = approval.approvalScope ? null : (approval.toolName ?? parsed.tool);
  const rows: ChoiceRow[] = approvalActionsFor(approval).map((action) => ({
    id: action.decision,
    label: t(action.labelKey),
    detail: t(action.descriptionKey),
    primary: action.tone === "primary",
    danger: action.tone === "destructive",
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
  const onKeyDown = letterKeyHandler(responding ? 0 : rows.length, (index) => {
    const row = rows[index];
    if (row) respond(row);
  });
  return (
    <div className="choice" onKeyDown={onKeyDown}>
      <div className="choice__head">
        <p className="choice__title">
          {t(approvalPromptKey(approval))}
          {toolName ? <span className="choice__tool">{toolName}</span> : null}
        </p>
        {pendingCount > 1 ? <span className="choice__count">1/{pendingCount}</span> : null}
      </div>
      <div className="choice__request">
        <ApprovalDetail
          parsed={parsed}
          {...(approval.permissionProfile ? { permissionProfile: approval.permissionProfile } : {})}
          {...(approval.toolName ? { toolName: approval.toolName } : {})}
          {...(approval.toolParamsDisplay ? { toolParamsDisplay: approval.toolParamsDisplay } : {})}
        />
      </div>
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
    detail: option.description === option.label ? undefined : option.description,
    picked: picked.has(option.label),
  }));
  const skipAll = () => pending.onCancel();
  const onKeyDown = letterKeyHandler(sending ? 0 : rows.length, (index) => {
    const row = rows[index];
    if (row) choose(row);
  });
  // One question with two short answers: the question and two buttons (an answer with its own
  // description keeps the lettered rows, where the description shows).
  const describes = rows.some((row) => row.detail);
  if (!paged && !question.multiSelect && question.options.length === 2 && !describes) {
    return (
      <>
        <div className="choice choice--pair" onKeyDown={onKeyDown}>
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
      <div className="choice" onKeyDown={onKeyDown}>
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
