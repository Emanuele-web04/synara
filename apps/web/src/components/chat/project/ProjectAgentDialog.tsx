import type { ModelSelection, ProjectId, ProviderKind } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { buildModelSelection } from "~/providerModelOptions";

import { ProviderModelPicker } from "../ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "../runtimeModelCapabilities";
import {
  defaultProjectAgentName,
  resolveProjectAgentModelSelection,
  resolveProjectAgentName,
} from "./projectAgentDialog.logic";

const FIELD_LABEL_CLASS_NAME =
  "text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground/80";

export type ProjectAgentDialogMode = "setup" | "edit";

export function ProjectAgentDialog(props: {
  open: boolean;
  mode: ProjectAgentDialogMode;
  projectId: ProjectId | null;
  projectName: string;
  agentName?: string | undefined;
  workspacePath: string;
  projectCwd: string;
  defaultModelSelection: ModelSelection | null;
  currentModelSelection?: ModelSelection | null;
  expectedRevision?: number | undefined;
  busy?: boolean | undefined;
  error?: string | null | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    coordinatorName: string;
    modelSelection: ModelSelection;
    expectedRevision?: number | undefined;
  }) => Promise<void> | void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "setup" ? "Set up project agent" : "Edit project agent"}
          </DialogTitle>
          <DialogDescription>
            {props.mode === "setup"
              ? "Assign a named agent and model to this project folder. Setup does not start a model turn."
              : "Update this project's named agent and model. Saving does not start a model turn."}
          </DialogDescription>
        </DialogHeader>
        {props.open ? (
          <ProjectAgentDialogForm
            mode={props.mode}
            projectName={props.projectName}
            agentName={props.agentName}
            workspacePath={props.workspacePath}
            projectCwd={props.projectCwd}
            defaultModelSelection={props.defaultModelSelection}
            currentModelSelection={props.currentModelSelection ?? null}
            projectId={props.projectId}
            expectedRevision={props.expectedRevision}
            busy={props.busy === true}
            error={props.error ?? null}
            onOpenChange={props.onOpenChange}
            onSave={props.onSave}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectAgentDialogForm(props: {
  mode: ProjectAgentDialogMode;
  projectId: ProjectId | null;
  projectName: string;
  agentName: string | undefined;
  workspacePath: string;
  projectCwd: string;
  defaultModelSelection: ModelSelection | null;
  currentModelSelection: ModelSelection | null;
  expectedRevision: number | undefined;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    coordinatorName: string;
    modelSelection: ModelSelection;
    expectedRevision?: number | undefined;
  }) => Promise<void> | void;
}) {
  const nameInputId = useId();
  const fallbackName = defaultProjectAgentName(props.projectName);
  const [name, setName] = useState(props.agentName?.trim() || fallbackName);
  const [modelSelection, setModelSelection] = useState<ModelSelection>(() =>
    resolveProjectAgentModelSelection({
      current: props.currentModelSelection,
      fallback: props.defaultModelSelection,
    }),
  );

  return (
    <form
      key={props.projectId ?? "project-agent"}
      onSubmit={(event) => {
        event.preventDefault();
        if (props.busy) return;
        void props.onSave({
          coordinatorName: resolveProjectAgentName({
            value: name,
            fallbackName,
          }),
          modelSelection,
          ...(props.mode === "edit" && props.expectedRevision !== undefined
            ? { expectedRevision: props.expectedRevision }
            : {}),
        });
      }}
    >
      <DialogPanel className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={nameInputId} className={cn("block", FIELD_LABEL_CLASS_NAME)}>
            Agent name
          </label>
          <Input
            id={nameInputId}
            value={name}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
            placeholder={fallbackName}
          />
        </div>
        <div className="space-y-1.5">
          <p className={FIELD_LABEL_CLASS_NAME}>Provider and model</p>
          <ProjectAgentModelPicker
            value={modelSelection}
            projectCwd={props.projectCwd}
            onChange={setModelSelection}
          />
        </div>
        <div className="space-y-1">
          <p className={FIELD_LABEL_CLASS_NAME}>Assigned folder</p>
          <p className="truncate text-[12px] text-muted-foreground" title={props.workspacePath}>
            {props.workspacePath.length > 0 ? props.workspacePath : "No folder assigned"}
          </p>
        </div>
        {props.error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {props.error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={props.busy}>
          {props.mode === "setup" ? "Set up project agent" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ProjectAgentModelPicker(props: {
  value: ModelSelection;
  projectCwd: string;
  onChange: (value: ModelSelection) => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [open, setOpen] = useState(false);
  const modelHintByProvider: Partial<Record<ProviderKind, string | null>> = {
    [props.value.provider]: props.value.model,
  };
  const {
    modelOptionsByProvider,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
  } = useProviderModelCatalog({
    selectedProvider: props.value.provider,
    discoveryEnabled: open,
    cwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: props.projectCwd.length > 0 ? props.projectCwd : null,
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
    modelHintByProvider,
  });

  return (
    <ProviderModelPicker
      compact
      provider={props.value.provider}
      model={props.value.model}
      lockedProvider={null}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={loadingModelProviders}
      discoveryErrorsByProvider={discoveryErrorsByProvider}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      open={open}
      onOpenChange={setOpen}
      onProviderModelChange={(provider, model) => {
        const runtimeModel = resolveRuntimeModelDescriptor({
          provider,
          model,
          runtimeModels: runtimeModelsByProvider[provider],
        });
        props.onChange(
          buildModelSelection(provider, model, undefined, runtimeModel?.supportsAutoMode),
        );
      }}
    />
  );
}
