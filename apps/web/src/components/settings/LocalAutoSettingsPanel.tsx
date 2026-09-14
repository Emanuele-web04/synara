import { LOCAL_AUTO_MODEL, type LocalAutoManageInput } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CentralIcon } from "~/lib/central-icons";
import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import { localAutoQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function LocalAutoSettingsPanel({ active }: { readonly active: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    ...localAutoQueryOptions(),
    enabled: active,
    refetchInterval: (state) => (active && state.state.data?.phase === "installing" ? 1000 : false),
  });
  const mutation = useMutation({
    mutationFn: (action: LocalAutoManageInput["action"]) =>
      ensureNativeApi().server.localAuto({ action }),
    onSuccess: (status) => {
      client.setQueryData(localAutoQueryOptions().queryKey, status);
    },
  });
  if (!active) return null;
  const status = query.data;
  const installing = status?.phase === "installing";
  const ready = status?.phase === "ready";
  const error = mutation.error ?? query.error;
  return (
    <div className="space-y-6">
      <SettingsSection title="Local tool review">
        <SettingsRow
          title="Auto 0.4b 2"
          description="Let a small model on this device review proposed tool calls in the context of your request and the agent’s actions."
          control={
            ready ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs text-primary">
                <CentralIcon name="shield-code" className="size-3.5" /> Installed
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!status || installing || mutation.isPending}
                onClick={() => mutation.mutate("install")}
              >
                {installing || mutation.isPending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
                {installing
                  ? "Installing…"
                  : status?.phase === "error"
                    ? "Retry installation"
                    : "Install Auto"}
              </Button>
            )
          }
        >
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CentralIcon name="shield-code" className="size-3.5" /> Runs on your device
            </span>
            <span>No API key</span>
            <a
              className="underline underline-offset-4 hover:text-foreground"
              href={`https://huggingface.co/${LOCAL_AUTO_MODEL}`}
              target="_blank"
              rel="noreferrer"
            >
              Model details ↗
            </a>
          </div>
          <div
            className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
            role="status"
            aria-live="polite"
          >
            <p
              className={`text-xs leading-relaxed ${status?.phase === "error" || error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {error ? error.message : (status?.detail ?? "Checking installation…")}
            </p>
            {installing ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate("cancel")}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Automatic hardware selection"
          description="Uses NVIDIA CUDA or Apple Silicon Metal when available, with a CPU fallback on supported systems."
          status={
            ready && status.device
              ? `Detected: ${status.device}`
              : "macOS on Apple Silicon · Windows and Linux on x64 / ARM64, where PyTorch wheels are available"
          }
        />
        <SettingsRow
          title="One-time download"
          description="Installs an isolated Python runtime, inference libraries, and the pinned model. No terminal setup required."
          status="Model: about 1.6 GB. Runtime size varies by device; allow several GB of free disk space."
        />
      </SettingsSection>
      <SettingsSection title="Using Auto mode">
        <SettingsRow
          title="Choose Auto (local) in a task"
          description="After installation, open the task’s permissions menu and select Auto (local). Available with Codex and Claude Code."
          status="Your existing task permissions stay the same until you select this mode."
        />
        <SettingsRow
          title="You stay in control"
          description="Authorized tool calls can proceed automatically. Calls the model denies, incomplete context, and unavailable reviews wait for your approval."
          status={
            ready && status.maxTokens
              ? `Full input only, with no truncation. This device supports up to ${status.maxTokens.toLocaleString()} tokens per review; longer inputs ask you.`
              : "A classifier can make mistakes. It reviews the approval requests exposed by your provider; it does not replace its sandbox."
          }
        />
      </SettingsSection>
    </div>
  );
}
