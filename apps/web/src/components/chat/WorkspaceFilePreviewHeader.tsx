// FILE: WorkspaceFilePreviewHeader.tsx
// Purpose: Editor-style header for the shared workspace file preview — a path
//          breadcrumb (project › …dirs › file) on the left, and an overflow
//          menu + "Open in editor" split button + copy-path control on the
//          right. Shared by the right-dock file pane and the editor center pane
//          so both surfaces read identically.
// Layer: Chat/editor file-preview UI
// Exports: WorkspaceFilePreviewHeader

import type { EditorId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { joinWorkspaceRelativePath } from "@t3tools/shared/path";
import { useQuery } from "@tanstack/react-query";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import type { ChatFileReference } from "~/lib/chatReferences";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  EyeIcon,
  FileIcon,
} from "~/lib/icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, ChatHeaderIconButton } from "./chatHeaderControls";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
// Window to flash the copy-path control's check glyph before reverting.
const COPY_FEEDBACK_MS = 1200;

interface WorkspaceFilePreviewHeaderProps {
  workspaceRoot: string;
  filePath: string;
  /** Markdown files get a source/preview toggle in the overflow menu. */
  isMarkdown: boolean;
  markdownPreviewEnabled: boolean;
  onToggleMarkdownPreview: () => void;
  /** Whole-file chat actions, surfaced in the overflow menu when wired. */
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  /** Shown when the preview only holds a partial read of a large file. */
  truncated?: boolean;
}

export const WorkspaceFilePreviewHeader = memo(function WorkspaceFilePreviewHeader(
  props: WorkspaceFilePreviewHeaderProps,
) {
  const { filePath, workspaceRoot } = props;
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;

  // Breadcrumb segments: project folder name, then each path part. Splitting
  // here (vs. rendering the raw string) lets the directory prefix collapse
  // first under width pressure while the filename stays pinned.
  const { prefixSegments, fileSegment } = useMemo(() => {
    const projectName = basenameOfPath(workspaceRoot);
    const relativeSegments = filePath.split("/").filter((segment) => segment.length > 0);
    const segments = projectName ? [projectName, ...relativeSegments] : relativeSegments;
    // Key each crumb by its cumulative path so repeated folder names (e.g. two
    // `src` dirs at different depths) still get stable, unique React keys.
    const prefix = segments.slice(0, -1).map((name, index) => ({
      name,
      key: segments.slice(0, index + 1).join("/"),
    }));
    return {
      prefixSegments: prefix,
      fileSegment: segments.at(-1) ?? filePath,
    };
  }, [filePath, workspaceRoot]);

  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  useEffect(() => {
    // The flashed "copied" state is purely cosmetic; clear any pending timer on
    // unmount (or filePath change) so it never fires against a stale element.
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);
  const handleCopyPath = useCallback(() => {
    void navigator.clipboard?.writeText(filePath);
    setCopied(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }, [filePath]);

  const { onReferenceInChat, onAskWhyInChat } = props;
  const referenceWholeFile = useCallback(() => {
    onReferenceInChat?.({ path: filePath });
  }, [filePath, onReferenceInChat]);
  const askWhyWholeFile = useCallback(() => {
    onAskWhyInChat?.({ path: filePath });
  }, [filePath, onAskWhyInChat]);

  const hasChatActions = Boolean(onReferenceInChat || onAskWhyInChat);
  const hasMenu = props.isMarkdown || hasChatActions;

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 px-3",
        CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
      )}
    >
      <nav
        aria-label="File path"
        className="flex min-w-0 flex-1 items-center text-[12px] leading-none"
      >
        <span className="flex min-w-0 items-center overflow-hidden">
          {prefixSegments.map((segment) => (
            <Fragment key={segment.key}>
              <span className="truncate text-muted-foreground/80">{segment.name}</span>
              <ChevronRightIcon
                aria-hidden="true"
                className="mx-0.5 size-3 shrink-0 text-muted-foreground/40"
              />
            </Fragment>
          ))}
        </span>
        <span className="shrink-0 truncate font-medium text-foreground" title={filePath}>
          {fileSegment}
        </span>
      </nav>

      {props.truncated ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">Shown partially</span>
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5">
        {hasMenu ? (
          <Menu>
            <MenuTrigger render={<ChatHeaderIconButton label="More actions" tone="plain" />}>
              <EllipsisIcon aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
              {props.isMarkdown ? (
                <MenuItem onClick={props.onToggleMarkdownPreview}>
                  <span className="shrink-0">
                    {props.markdownPreviewEnabled ? (
                      <FileIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    ) : (
                      <EyeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    )}
                  </span>
                  {props.markdownPreviewEnabled ? "View source" : "View rendered"}
                </MenuItem>
              ) : null}
              {props.isMarkdown && hasChatActions ? <MenuSeparator className="mx-1" /> : null}
              {onReferenceInChat ? (
                <MenuItem onClick={referenceWholeFile}>Reference in chat</MenuItem>
              ) : null}
              {onAskWhyInChat ? (
                <MenuItem onClick={askWhyWholeFile}>Ask why this changed</MenuItem>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}

        <OpenInPicker
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInTarget={joinWorkspaceRelativePath(workspaceRoot, filePath)}
          labelMode="always"
        />

        <ChatHeaderIconButton
          type="button"
          tone="plain"
          label={copied ? "Path copied" : "Copy path"}
          title={copied ? "Path copied" : "Copy path"}
          onClick={handleCopyPath}
        >
          {copied ? (
            <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
          ) : (
            <CopyIcon aria-hidden="true" className="size-3.5" />
          )}
        </ChatHeaderIconButton>
      </div>
    </div>
  );
});
