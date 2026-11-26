// FILE: UsageHubsSection.tsx
// Purpose: Settings → Usage → Usage hubs. Lists CLIProxyAPI hubs with one usage card per pooled
// Codex/Claude account, and adds or removes hubs. The management key is sent once on add and
// stays in the server's secret store.

import type { ServerUsageHub } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";

import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import { ProviderUsageCard } from "~/components/settings/ProviderUsageSettingsPanel";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
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
import { Label } from "~/components/ui/label";
import { toastManager } from "~/components/ui/toast";
import { AddPlusIcon, TriangleAlertIcon } from "~/lib/icons";
import { serverQueryKeys, serverUsageHubsQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";

function AddUsageHubDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      ensureNativeApi().server.addUsageHub({
        url: url.trim(),
        managementKey: managementKey.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: (hub) => {
      queryClient.setQueryData<ReadonlyArray<ServerUsageHub>>(
        serverQueryKeys.usageHubs(),
        (current) => [...(current ?? []).filter((existing) => existing.id !== hub.id), hub],
      );
    },
  });
  const reset = () => {
    setUrl("");
    setManagementKey("");
    setLabel("");
    setError(null);
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await mutation.mutateAsync();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the hub.");
    }
  };
  const canSave = url.trim().length > 0 && managementKey.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a CLIProxyAPI hub</DialogTitle>
          <DialogDescription>
            Show the quota of every account the hub pools. The key stays on this server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-url`}>Hub URL</Label>
              <Input
                id={`${formId}-url`}
                placeholder="https://hub.example.ts.net:8318"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-key`}>Management key</Label>
              <Input
                id={`${formId}-key`}
                type="password"
                autoComplete="off"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-label`}>Label (optional)</Label>
              <Input
                id={`${formId}-label`}
                placeholder="Defaults to the hub's host name"
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSave || mutation.isPending}>
            Add hub
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UsageHubBlock({ hub }: { hub: ServerUsageHub }) {
  const queryClient = useQueryClient();
  const removeMutation = useMutation({
    mutationFn: () => ensureNativeApi().server.removeUsageHub({ id: hub.id }),
    // A poll that started before the removal would otherwise put the hub back.
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: serverQueryKeys.usageHubs() });
      queryClient.setQueryData<ReadonlyArray<ServerUsageHub>>(
        serverQueryKeys.usageHubs(),
        (current) => (current ?? []).filter((existing) => existing.id !== hub.id),
      );
    },
  });
  const remove = async () => {
    const message = `Remove the usage hub "${hub.label}"? Its management key is deleted from this server.`;
    const api = readNativeApi();
    const confirmed = api
      ? await api.dialogs.confirm(message)
      : await showConfirmDialogFallback(message);
    if (!confirmed) return;
    try {
      await removeMutation.mutateAsync();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not remove the hub",
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-2">
        <div className="min-w-0">
          <p className="truncate text-ui-lg font-semibold text-foreground">{hub.label}</p>
          <p className="truncate text-ui-sm text-muted-foreground" title={hub.url}>
            {hub.url}
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={removeMutation.isPending}
          onClick={() => void remove()}
        >
          Remove
        </Button>
      </div>
      {hub.error ? (
        <p className="flex items-start gap-1.5 px-2 text-ui leading-relaxed text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{hub.error}</span>
        </p>
      ) : hub.accounts.length === 0 ? (
        <p className="px-2 text-ui text-muted-foreground">
          This hub has no enabled Codex or Claude accounts.
        </p>
      ) : (
        hub.accounts.map((account) => (
          <ProviderUsageCard
            key={account.id}
            snapshot={account.usage}
            accountLabel={account.email ?? account.id}
          />
        ))
      )}
    </div>
  );
}

export function UsageHubsSection() {
  const [adding, setAdding] = useState(false);
  const hubsQuery = useQuery(serverUsageHubsQueryOptions());
  const hubs = hubsQuery.data ?? [];

  return (
    <SettingsSectionShell
      title="Usage hubs"
      translateTitle={false}
      action={
        <Button size="xs" variant="outline" className="shrink-0" onClick={() => setAdding(true)}>
          <AddPlusIcon className="size-3.5" />
          Add hub
        </Button>
      }
    >
      {hubsQuery.isPending ? (
        <SettingsCard>
          <div className="px-4 py-3.5 text-ui leading-snug text-muted-foreground">
            Loading usage hubs…
          </div>
        </SettingsCard>
      ) : hubsQuery.isError ? (
        <p className="px-2 text-ui text-muted-foreground">
          {hubsQuery.error instanceof Error
            ? hubsQuery.error.message
            : "Could not load usage hubs."}
        </p>
      ) : hubs.length === 0 ? (
        <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
          Add a CLIProxyAPI hub to see the quota of every Codex and Claude account it pools.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {hubs.map((hub) => (
            <UsageHubBlock key={hub.id} hub={hub} />
          ))}
        </div>
      )}
      <AddUsageHubDialog open={adding} onOpenChange={setAdding} />
    </SettingsSectionShell>
  );
}
