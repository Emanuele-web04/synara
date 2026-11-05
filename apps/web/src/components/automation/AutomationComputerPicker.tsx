import { readExecutionContext } from "~/lib/hosts/executionContext";
import type { AutomationFormState } from "~/lib/automationForm";
import {
  portableAutomationDraft,
  prepareWorkspaceAutomation,
} from "~/lib/hosts/automationWorkspace";
import { readWorkspaceFrame, workspaceRoute } from "~/lib/hosts/workspaceFrame";
import { readWorkspaceSessions } from "~/lib/hosts/workspaceSessions";
import { ComputerPicker, useWorkspaceComputers } from "../hosts/ComputerPicker";
import { toastManager } from "../ui/toast";

export function AutomationComputerPicker({
  form,
  disabled,
  onMoved,
}: {
  readonly form: AutomationFormState;
  readonly disabled: boolean;
  readonly onMoved: () => void;
}) {
  const { computers, currentId, localId, navigate } = useWorkspaceComputers();
  const context = readExecutionContext();
  if (context?.controller.capabilities.remoteConnections !== true)
    return <span>{context?.execution.label ?? "This computer"}</span>;
  const select = (id: string) => {
    if (disabled || id === currentId) return;
    const frame = readWorkspaceFrame();
    try {
      const draft = portableAutomationDraft(form);
      let path: string;
      if (id === localId) {
        const prepare = frame ? frame.controller.prepareAutomation : prepareWorkspaceAutomation;
        if (!prepare) throw new Error("Update this computer to create automations here.");
        path = prepare(draft);
      } else {
        const session = (frame?.controller.sessions ?? readWorkspaceSessions)().find(
          (entry) => entry.host.executionScope.environmentId === id,
        );
        if (
          session?.error ||
          session?.summary?.state !== "open" ||
          !session.navigation?.prepareAutomation
        )
          throw new Error("Connect this computer before creating an automation.");
        path = workspaceRoute(id, session.navigation.prepareAutomation(draft));
      }
      onMoved();
      navigate(path);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not select computer",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
  return (
    <ComputerPicker
      computers={computers}
      value={currentId}
      disabled={disabled}
      purpose="Run on"
      onChange={select}
      onManage={() => navigate("/settings?section=connections")}
    />
  );
}
