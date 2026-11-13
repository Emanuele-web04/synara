import { describeErrorMessage } from "@synara/shared/errorMessages";
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
import { reconnectWorkspaceComputer } from "../../lib/hosts/workspaceReconnect";
import { CheckIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { hoverRevealHideClassName } from "../../rowHoverReveal";
import { RowHoverActions } from "../RowHoverActions";
import { buttonVariants } from "../ui/button";
import { isHostSettingsSection, type SettingsSectionId } from "../../settingsNavigation";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export interface ComputerChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly available: boolean;
  /** An unavailable connected computer that the controller can redial on request. */
  readonly reconnectable?: boolean;
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
    ...sessions.map((session) => {
      const available =
        !session.error && Boolean(session.navigation) && session.summary?.state === "open";
      return {
        id: session.host.executionScope.environmentId,
        label: session.host.hostName,
        detail: session.error
          ? "Unavailable"
          : session.summary?.state === "open"
            ? "Connected"
            : "Reconnecting…",
        available,
        reconnectable: !available,
      };
    }),
  ];
  // A frame cannot reach the controller's sessions directly, so it asks through its bridge.
  const reconnect = frame ? frame.controller.reconnect : reconnectWorkspaceComputer;
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
    reconnect,
  };
}

function ComputerChoiceText({
  computer,
  detail = computer.detail,
  reserveHoverActions = false,
}: {
  computer: ComputerChoice;
  detail?: string;
  reserveHoverActions?: boolean;
}) {
  // While the row shows its action, the text yields that width and fades under it,
  // like a sidebar chat title behind its pin and archive actions.
  const lineClassName = reserveHoverActions ? "block min-w-0 truncate-fade" : "block truncate";
  return (
    <span
      className={cn(
        "min-w-0 flex-1",
        reserveHoverActions && "group-data-highlighted/picker-row:pr-[6em]",
      )}
    >
      <span className={lineClassName}>{computer.label}</span>
      <span className={cn(lineClassName, "text-ui-xs text-muted-foreground")}>{detail}</span>
    </span>
  );
}

/** Picker rows for unavailable computers redial on click and reveal the action on hover. */
function ReconnectComputerMenuItem({
  computer,
  selected,
  onReconnect,
}: {
  computer: ComputerChoice;
  selected: boolean;
  onReconnect: (environmentId: string) => Promise<void>;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const reconnect = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await onReconnect(computer.id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not reconnect ${computer.label}`,
        // A frame's bridge rejects with the controller realm's Error, so read it structurally.
        description: describeErrorMessage(
          error,
          "Check that the computer is online and try again.",
        ),
      });
    } finally {
      setReconnecting(false);
    }
  };
  return (
    <MenuItem
      className="group/picker-row relative"
      closeOnClick={false}
      disabled={reconnecting}
      onClick={() => void reconnect()}
    >
      <ComputerChoiceText
        computer={computer}
        detail={reconnecting ? "Reconnecting…" : computer.detail}
        reserveHoverActions
      />
      {selected ? (
        <CheckIcon className={cn("size-3.5 shrink-0", hoverRevealHideClassName("picker-row"))} />
      ) : null}
      <RowHoverActions group="picker-row" className="right-2">
        <span
          className={buttonVariants({ size: "xs", shape: "capsule", variant: "secondary-outline" })}
        >
          Reconnect
        </span>
      </RowHoverActions>
    </MenuItem>
  );
}

export function ComputerPicker({
  computers,
  value,
  disabled,
  onChange,
  onManage,
  onReconnect,
  purpose = "Computer",
}: {
  computers: readonly ComputerChoice[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  onManage?: (() => void) | undefined;
  onReconnect?: ((environmentId: string) => Promise<void>) | undefined;
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
        {computers.map((computer) =>
          !computer.available && computer.reconnectable && onReconnect ? (
            <ReconnectComputerMenuItem
              key={computer.id}
              computer={computer}
              selected={computer.id === value}
              onReconnect={onReconnect}
            />
          ) : (
            <MenuItem
              key={computer.id}
              disabled={!computer.available}
              onClick={() => onChange(computer.id)}
            >
              <ComputerChoiceText computer={computer} />
              {computer.id === value ? <CheckIcon className="size-3.5 shrink-0" /> : null}
            </MenuItem>
          ),
        )}
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

/** Open the selected computer's overview without carrying another owner's IDs or filters. */
export function WorkspaceSurfaceComputerPicker({
  path,
}: {
  path: "/tasks" | "/kanban" | "/inbox" | "/pull-requests";
}) {
  const { computers, localId, currentId, navigate, reconnect } = useWorkspaceComputers();
  const frame = readWorkspaceFrame();
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  const select = (environmentId: string) => {
    if (environmentId === currentId) return;
    if (environmentId === localId) {
      navigate(path);
      return;
    }
    const session = (frame?.controller.sessions ?? readWorkspaceSessions)().find(
      (item) => item.host.executionScope.environmentId === environmentId,
    );
    if (!session?.navigation || session.error || session.summary?.state !== "open") {
      toastManager.add({
        type: "error",
        title: "Computer unavailable",
        description: "Reconnect this computer in Connections and try again.",
      });
      return;
    }
    navigate(workspaceRoute(environmentId, path));
  };
  return (
    <div className="min-w-0 [-webkit-app-region:no-drag]">
      <ComputerPicker
        computers={computers}
        value={currentId}
        onChange={select}
        onManage={() => navigate("/settings?section=connections")}
        onReconnect={reconnect}
      />
    </div>
  );
}

/** The main window's Settings route resolves `computer` and opens host-owned sections on it. */
export function SettingsComputerPicker({ section }: { section: SettingsSectionId }) {
  const { computers, sessions, localId, currentId, navigate, reconnect } = useWorkspaceComputers();
  const frame = readWorkspaceFrame();
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  if (!isHostSettingsSection(section)) {
    return (
      <div className="mb-4 flex min-w-0 items-center gap-2 text-ui-sm text-muted-foreground">
        <span>Settings for</span>
        <span
          className="truncate text-foreground"
          title="These settings always apply to this computer."
        >
          This computer
        </span>
      </div>
    );
  }
  const select = (environmentId: string) => {
    if (environmentId === currentId) return;
    if (environmentId !== localId) {
      const selected = sessions.find(
        (session) => session.host.executionScope.environmentId === environmentId,
      )?.host;
      const session = (frame?.controller.sessions ?? readWorkspaceSessions)().find(
        (item) => item.host === selected,
      );
      if (!session?.navigation || session.error || session.summary?.state !== "open") {
        toastManager.add({
          type: "error",
          title: "Computer unavailable",
          description: "Reconnect this computer in Connections and try again.",
        });
        return;
      }
    }
    const search = new URLSearchParams({
      section,
      computer: environmentId === localId ? "local" : environmentId,
    });
    navigate(`/settings?${search}`);
  };
  return (
    <div className="mb-4 flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground">
      <span>Settings for</span>
      <ComputerPicker
        computers={computers}
        value={currentId}
        purpose="Settings for"
        onChange={select}
        onManage={() => navigate("/settings?section=connections")}
        onReconnect={reconnect}
      />
    </div>
  );
}

/** Selecting another computer opens its own draft; it never migrates the current one. */
export function NewChatComputerPicker() {
  const { computers, sessions, localId, currentId, navigate, reconnect } = useWorkspaceComputers();
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
      onReconnect={reconnect}
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
