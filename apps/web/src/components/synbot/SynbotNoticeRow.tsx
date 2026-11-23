// FILE: SynbotNoticeRow.tsx
// Purpose: SynBot's cards where a bot's activity shows in Synara's own transcript: the "From
//          <bot>" line in a chat a bot wrote to or stopped, and, when a bot's thread opens in the
//          normal thread view, its delegation, choice and report cards and the "Message from"
//          row. They are the SynBot page's own cards (thread/SynbotCards.tsx), kit-scoped.
// Layer: SynBot UI (rendered by MessagesTimeline)
// Exports: SynbotNoticeRow, SynbotMessageFromRow, isSynbotDelegationMessageId

import { BOT_DELEGATION_MESSAGE_PREFIX, type ThreadId } from "@synara/contracts";

import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import "./kit/holobot.css";
import "./thread/thread.css";
import { MessageFromRow, SynbotCard } from "./thread/SynbotCards";

export const isSynbotDelegationMessageId = (id: string) =>
  id.startsWith(BOT_DELEGATION_MESSAGE_PREFIX);

/** One SynBot card for a `synbot.*` work-log entry (activity id in `entryId`). */
export function SynbotNoticeRow({
  entryId,
  notice,
  threadId,
}: {
  readonly entryId: string;
  readonly notice: WorkLogSynbotNotice;
  readonly threadId: ThreadId | null;
}) {
  return (
    <div className="hb synbot-notice">
      <SynbotCard entryId={entryId} notice={notice} threadId={threadId} />
    </div>
  );
}

/** Replaces a delegation's long prompt in the target bot's chat with who asked and the brief. */
export function SynbotMessageFromRow({ messageId }: { readonly messageId: string }) {
  const delegationId = messageId.slice(BOT_DELEGATION_MESSAGE_PREFIX.length);
  const brief = useSynbotStore(
    (store) => store.data.delegations.find((entry) => entry.id === delegationId)?.brief ?? null,
  );
  if (brief === null) return null;
  return (
    <div className="hb synbot-notice">
      <MessageFromRow delegationId={delegationId} brief={brief} />
    </div>
  );
}
