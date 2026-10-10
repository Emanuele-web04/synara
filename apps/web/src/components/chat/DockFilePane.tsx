import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";

export function DockFilePane(props: {
  workspaceRoot: string | null;
  filePath: string | null;
  isVisible: boolean;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  return (
    <WorkspaceFilePreview
      workspaceRoot={props.workspaceRoot}
      filePath={props.filePath}
      liveRevalidationEnabled={props.isVisible}
      markdownPreviewDefault
      emptyState={
        <PanelStateMessage density="compact" fill="flex">
          <p>Click a file in the chat to preview it here.</p>
        </PanelStateMessage>
      }
      onReferenceInChat={props.onReferenceInChat}
      onAskWhyInChat={props.onAskWhyInChat}
      onCommentInChat={props.onCommentInChat}
    />
  );
}
