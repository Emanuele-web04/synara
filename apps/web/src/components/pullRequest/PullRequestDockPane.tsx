// FILE: PullRequestDockPane.tsx
// Purpose: Adapter from a right-dock "pullRequest" pane to the detail panel — the single place
//          that validates the pane's identity fields, builds the PullRequestDetailInput, and
//          keys the panel so switching pull requests remounts it. The chat thread dock's pull
//          request pane (the inbox route shows the panel inline instead); its Ask opens the
//          host thread's side chat.
// Layer: Pull request presentation
// Exports: PullRequestDockPane

import type { ThreadId } from "@synara/contracts";

import type { RightDockPane } from "~/rightDockStore.logic";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import {
  pullRequestDetailInputFromPane,
  pullRequestDetailInputKey,
} from "./pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { useHostThreadSidechatAsk } from "./useHostThreadSidechatAsk";

export function PullRequestDockPane({
  pane,
  hostThreadId,
  onClose,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
}: {
  pane: RightDockPane;
  /** The thread whose dock shows this pane; Ask starts or reopens its side chat. */
  hostThreadId?: ThreadId | undefined;
  onClose?: (() => void) | undefined;
  onSelectPullRequest?: ((number: number) => void) | undefined;
  pollingEnabled?: boolean;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
  const hostSidechat = useHostThreadSidechatAsk(hostThreadId ?? null);
  const input = pullRequestDetailInputFromPane(pane);
  if (!input) {
    return <PanelStateMessage>Select a pull request to open it here.</PanelStateMessage>;
  }
  return (
    <PullRequestDetailPanel
      key={pullRequestDetailInputKey(input)}
      input={input}
      initialTab={pane.pullRequestInitialTab ?? "summary"}
      pollingEnabled={pollingEnabled}
      onAsk={hostSidechat.ask}
      askPending={hostSidechat.pending}
      {...(onClose ? { onClose } : {})}
      {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
    />
  );
}

export default PullRequestDockPane;
