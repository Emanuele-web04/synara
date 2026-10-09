import { ProjectCatalogDialog } from "./ProjectCatalogDialog";
import { readRecoverableEditorDrafts } from "~/lib/hosts/editorRecovery";
import { readUnsavedExecutionDrafts } from "~/lib/hosts/executionSwitch";
import { ensureNativeApi } from "~/nativeApi";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { deactivateHost } from "~/lib/hosts/activeHost";
import { addWsTransportStateListener, type WsTransportState } from "~/wsTransportEvents";
import { ServerIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuItem, MenuSeparator } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { toastManager } from "../ui/toast";

/** Execution destination is visible independently of account and cloud state. */
export function HostConnectionControl({ compact = false }: { compact?: boolean }) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const context = readExecutionContext();
  const navigate = useNavigate();
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  if (!context) return null;
  const label = context.remote ? context.execution.label : "This computer";
  const channel = context.remote?.channel ?? context.controller.channel;
  const destination = channel
    ? `${label} · ${channel === "dev" ? "Development" : `Synara ${channel[0]!.toUpperCase()}${channel.slice(1)}`}`
    : label;
  const status =
    state === "open"
      ? "Connected"
      : state === "connecting"
        ? "Connecting…"
        : state === "incompatible"
          ? "Update required"
          : "Connection unavailable";
  const back = () => {
    try {
      deactivateHost();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not preserve editor drafts",
        description:
          error instanceof Error
            ? error.message
            : "Copy your unsaved text before returning locally.",
      });
    }
  };
  const exportDrafts = async () => {
    try {
      const recovered = readRecoverableEditorDrafts();
      const current = readUnsavedExecutionDrafts();
      if (!current.length && !recovered.length) {
        toastManager.add({ type: "info", title: "No editor drafts to recover" });
        return;
      }
      const saveFile = ensureNativeApi().dialogs.saveFile;
      if (!saveFile) throw new Error("File export is unavailable in this client.");
      await saveFile({
        defaultFilename: "synara-editor-drafts.json",
        contents: JSON.stringify(
          { environmentId: context.execution.environmentId, host: label, current, recovered },
          null,
          2,
        ),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not export drafts",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size={compact ? "icon" : "sm"}
              className={
                compact
                  ? "size-9"
                  : "h-auto sm:h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
              }
              aria-label={`${destination}. ${status}`}
              title={`${destination}. ${status}`}
            />
          }
        >
          <ServerIcon className="size-4 shrink-0" />
          {!compact ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-sm">{destination}</span>
              <span className="block text-ui-xs text-muted-foreground">{status}</span>
            </span>
          ) : null}
        </MenuTrigger>
        <ComposerPickerMenuPopup side={compact ? "right" : "top"} align="start" className="w-64">
          <div className="px-2 py-1.5">
            <p className="truncate text-ui font-medium">{destination}</p>
            <p className="text-ui-sm text-muted-foreground">{status}</p>
          </div>
          {context.remote ? (
            <>
              <MenuItem onClick={back}>Back to this computer</MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => setCatalogOpen(true)}>Linked projects</MenuItem>
          <MenuItem onClick={() => void exportDrafts()}>Export editor drafts</MenuItem>
          <MenuItem
            onClick={() => void navigate({ to: "/settings", search: { section: "connections" } })}
          >
            Manage connections
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {catalogOpen ? <ProjectCatalogDialog onClose={() => setCatalogOpen(false)} /> : null}
    </>
  );
}
