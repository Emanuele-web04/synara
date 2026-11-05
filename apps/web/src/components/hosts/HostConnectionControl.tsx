import { useTranslation } from "~/i18n";
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
  const { t } = useTranslation();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const context = readExecutionContext();
  const navigate = useNavigate();
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  if (!context) return null;
  // Exported metadata retains its source label independently of the UI language.
  const sourceLabel = context.remote ? context.execution.label : "This computer";
  const label = context.remote ? sourceLabel : t("computer:remote_host_this_computer");
  const channel = context.remote?.channel ?? context.controller.channel;
  const destination = channel
    ? `${label} · ${channel === "dev" ? t("computer:remote_host_development") : `Synara ${channel[0]!.toUpperCase()}${channel.slice(1)}`}`
    : label;
  const status =
    state === "open"
      ? t("chat:connected")
      : state === "connecting"
        ? t("computer:connecting")
        : state === "incompatible"
          ? t("computer:remote_host_update_required")
          : t("computer:remote_host_connection_unavailable");
  const back = () => {
    try {
      deactivateHost();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("computer:remote_host_preserve_drafts_failed"),
        description:
          error instanceof Error
            ? error.message
            : t("computer:remote_host_copy_drafts_before_return"),
      });
    }
  };
  const exportDrafts = async () => {
    try {
      const recovered = readRecoverableEditorDrafts();
      const current = readUnsavedExecutionDrafts();
      if (!current.length && !recovered.length) {
        toastManager.add({ type: "info", title: t("computer:remote_host_no_drafts") });
        return;
      }
      const saveFile = ensureNativeApi().dialogs.saveFile;
      if (!saveFile) throw new Error(t("computer:remote_host_file_export_unavailable"));
      await saveFile({
        defaultFilename: "synara-editor-drafts.json",
        contents: JSON.stringify(
          { environmentId: context.execution.environmentId, host: sourceLabel, current, recovered },
          null,
          2,
        ),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("computer:remote_host_export_drafts_failed"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
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
              <MenuItem onClick={back}>{t("computer:remote_host_back_this_computer")}</MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => setCatalogOpen(true)}>
            {t("computer:remote_host_linked_projects")}
          </MenuItem>
          <MenuItem onClick={() => void exportDrafts()}>
            {t("computer:remote_host_export_drafts")}
          </MenuItem>
          <MenuItem
            onClick={() => void navigate({ to: "/settings", search: { section: "connections" } })}
          >
            {t("computer:remote_host_manage_connections")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {catalogOpen ? <ProjectCatalogDialog onClose={() => setCatalogOpen(false)} /> : null}
    </>
  );
}
