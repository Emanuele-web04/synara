import { addWsTransportStateListener, type WsTransportState } from "../../wsTransportEvents";
import { useEffect, useState, useSyncExternalStore } from "react";
import { appHistory } from "../../appNavigation";
import { useHandleNewChat } from "../../hooks/useHandleNewChat";
import { readExecutionContext } from "../../lib/hosts/executionContext";
import { readWorkspaceFrame, workspaceRoute } from "../../lib/hosts/workspaceFrame";
import {
  readWorkspaceSessions,
  subscribeWorkspaceSessions,
} from "../../lib/hosts/workspaceSessions";
import { CheckIcon } from "../../lib/icons";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export interface ComputerChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly available: boolean;
}

/** Frames read the controller's directory, while commands retain their owning runtime. */
export function useWorkspaceComputers() {
  const frame = readWorkspaceFrame();
  const context = readExecutionContext();
  const sessions = useSyncExternalStore(
    frame?.controller.subscribe ?? subscribeWorkspaceSessions,
    frame?.controller.sessions ?? readWorkspaceSessions,
    frame?.controller.sessions ?? readWorkspaceSessions,
  );
  const local = frame?.controller.environment ?? context?.controller;
  const localId = local?.environmentId ?? "local";
  const computers: ComputerChoice[] = [
    { id: localId, label: "This computer", detail: local?.label ?? "Local", available: true },
    ...sessions.map((session) => ({
      id: session.host.executionScope.environmentId,
      label: session.host.hostName,
      detail: session.error
        ? "Unavailable"
        : session.summary?.state === "open"
          ? "Connected"
          : "Reconnecting…",
      available: Boolean(session.navigation) && session.summary?.state === "open",
    })),
  ];
  const navigate = (path: string) => {
    if (frame) frame.controller.navigate(path);
    else appHistory.push(path);
  };
  return {
    computers,
    sessions,
    localId,
    currentId: context?.execution.environmentId ?? localId,
    navigate,
  };
}

export function ComputerPicker({
  computers,
  value,
  disabled,
  onChange,
  onManage,
  purpose = "Computer",
}: {
  computers: readonly ComputerChoice[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  onManage?: (() => void) | undefined;
  purpose?: string;
}) {
  const selected = computers.find((computer) => computer.id === value);
  if (!onManage && computers.length === 1)
    return <span className="text-ui text-foreground">{selected?.label}</span>;
  return (
    <Menu>
      <MenuTrigger
        render={
          <PickerTriggerButton
            icon={null}
            label={selected?.label ?? "Computer unavailable"}
            aria-label={`${purpose}: ${selected?.label ?? "unavailable"}`}
            title={selected?.detail}
            variant="ghost"
            disabled={disabled}
          />
        }
      />
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-72">
        <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">{purpose}</p>
        {computers.map((computer) => (
          <MenuItem
            key={computer.id}
            disabled={!computer.available}
            onClick={() => onChange(computer.id)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{computer.label}</span>
              <span className="block truncate text-ui-xs text-muted-foreground">
                {computer.detail}
              </span>
            </span>
            {computer.id === value ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </MenuItem>
        ))}
        {onManage ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={onManage}>Connect a computer…</MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Selecting another computer opens its own draft; it never migrates the current one. */
export function NewChatComputerPicker() {
  const { computers, sessions, localId, currentId, navigate } = useWorkspaceComputers();
  const { handleNewChat } = useHandleNewChat();
  const [busy, setBusy] = useState(false);
  const frame = readWorkspaceFrame();
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  const select = async (environmentId: string) => {
    if (busy || environmentId === currentId) return;
    setBusy(true);
    try {
      if (environmentId === localId) {
        if (frame) navigate(await frame.controller.newChat());
        else {
          const result = await handleNewChat();
          if (!result.ok) throw new Error(result.error);
        }
      } else {
        const session = sessions.find(
          (item) => item.host.executionScope.environmentId === environmentId,
        );
        const navigation = session?.navigation;
        if (!navigation || session?.summary?.state !== "open")
          throw new Error("This computer is not connected.");
        const path = await navigation.newChat();
        const current = (frame?.controller.sessions ?? readWorkspaceSessions)();
        if (!current.some((item) => item.host === session.host && item.navigation === navigation))
          throw new Error("The connection changed. Choose the computer again.");
        navigate(workspaceRoute(environmentId, path));
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open chat",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ComputerPicker
      computers={computers}
      value={currentId}
      disabled={busy}
      purpose="Run on"
      onChange={(id) => void select(id)}
      onManage={() => navigate("/settings?section=connections")}
    />
  );
}

/** Task ownership belongs beside its title, independently of the selected sidebar section. */
export function ChatComputerLabel() {
  const context = readExecutionContext();
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(
    () =>
      context?.remote ? addWsTransportStateListener(setState, { replayCurrent: true }) : undefined,
    [context],
  );
  if (!context?.remote) return null;
  const status =
    state === "open" ? "Connected" : state === "incompatible" ? "Update required" : "Reconnecting…";
  return (
    <span
      className="min-w-0 max-w-40 truncate text-ui-xs text-muted-foreground"
      title={`${context.execution.label} · ${status}`}
      aria-label={`Computer: ${context.execution.label}. ${status}`}
    >
      {context.execution.label}
      {state === "open" ? null : ` · ${status}`}
    </span>
  );
}
