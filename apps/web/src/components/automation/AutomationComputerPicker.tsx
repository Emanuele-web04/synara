import { useTranslation } from "~/i18n";
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
  const { t } = useTranslation();
  const { computers, currentId, localId, navigate } = useWorkspaceComputers();
  const context = readExecutionContext();
  if (context?.controller.capabilities.remoteConnections !== true)
    return <span>{context?.execution.label ?? t("workspace:remote_workspace_thisComputer")}</span>;
  const select = (id: string) => {
    if (disabled || id === currentId) return;
    const frame = readWorkspaceFrame();
    try {
      const draft = portableAutomationDraft(form);
      let path: string;
      if (id === localId) {
        const prepare = frame ? frame.controller.prepareAutomation : prepareWorkspaceAutomation;
        if (!prepare) throw new Error(t("automation:remote_workspace_updateForAutomations"));
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
          throw new Error(t("automation:remote_workspace_connectBeforeAutomation"));
        path = workspaceRoute(id, session.navigation.prepareAutomation(draft));
      }
      onMoved();
      navigate(path);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("automation:remote_workspace_selectComputerFailed"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
      });
    }
  };
  return (
    <ComputerPicker
      computers={computers}
      value={currentId}
      disabled={disabled}
      purpose={t("workspace:remote_workspace_runOn")}
      onChange={select}
      onManage={() => navigate("/settings?section=connections")}
    />
  );
}
