import type { RightDockPane } from "~/rightDockStore.logic";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import {
  pullRequestDetailInputFromPane,
  pullRequestDetailInputKey,
} from "./pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

export function PullRequestDockPane({
  pane,
  onClose,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
}: {
  pane: RightDockPane;
  onClose?: (() => void) | undefined;
  onSelectPullRequest?: ((number: number) => void) | undefined;
  pollingEnabled?: boolean;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
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
      {...(onClose ? { onClose } : {})}
      {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
    />
  );
}

export default PullRequestDockPane;
