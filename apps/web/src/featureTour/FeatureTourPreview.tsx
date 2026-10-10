import type { ReactNode } from "react";
import { ProviderIcon } from "~/components/ProviderIcon";
import { CheckIcon, GitPullRequestIcon, UsersIcon, WorkflowIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { FeatureTourSlide } from "./content";

// One quiet illustration per slide: just the piece of the app the slide is about, drawn
// with the workspace's own glyphs and surface tokens. No live chats or provider/GitHub
// requests in a startup dialog, and no window chrome around the piece.
export function FeatureTourPreview({ slide }: { slide: FeatureTourSlide }) {
  return (
    <div className="flex h-[184px] w-full items-center justify-center rounded-xl bg-muted/40 px-6">
      <div key={slide.id} className="sidebar-surface-enter w-full max-w-[300px]">
        {slide.id === "workspace" ? <WorkspacePreview /> : null}
        {slide.id === "accounts" ? <AccountsPreview /> : null}
        {slide.id === "review" ? <ReviewPreview /> : null}
        {slide.id === "hubs" ? <HubPreview /> : null}
      </div>
    </div>
  );
}

function Chip({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-ui-sm shadow-xs",
        active ? "border-primary/30" : "border-border",
      )}
    >
      {children}
    </div>
  );
}

function SkeletonLines() {
  return (
    <>
      <div className="h-1.5 w-4/5 rounded bg-foreground/10" />
      <div className="h-1.5 w-3/5 rounded bg-foreground/10" />
      <div className="h-1.5 w-2/3 rounded bg-foreground/10" />
    </>
  );
}

function WorkspacePreview() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        <Chip active>
          <ProviderIcon provider="codex" className="size-3.5 shrink-0" />
          <span className="truncate">Dashboard</span>
        </Chip>
        <Chip>
          <ProviderIcon provider="claudeAgent" className="size-3.5 shrink-0" />
          <span className="truncate">API review</span>
        </Chip>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[0, 1].map((pane) => (
          <div
            key={pane}
            className="flex h-[88px] flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-xs"
          >
            <SkeletonLines />
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountsPreview() {
  const rows = [
    { provider: "codex", name: "Personal", active: true },
    { provider: "codex", name: "Work", active: false },
    { provider: "claudeAgent", name: "Personal", active: false },
  ] as const;
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-background p-1 text-ui-sm shadow-sm">
      {rows.map((row) => (
        <div
          key={`${row.provider}-${row.name}`}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2.5 py-1.5",
            row.active && "bg-muted",
          )}
        >
          <ProviderIcon provider={row.provider} className="size-4 shrink-0" />
          <span>{row.name}</span>
          {row.active ? <CheckIcon className="ms-auto size-3.5 text-primary" /> : null}
        </div>
      ))}
    </div>
  );
}

function ReviewPreview() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3 text-ui-sm shadow-sm">
      <div className="flex items-center gap-2 font-medium">
        <GitPullRequestIcon className="size-4 shrink-0 text-success" />
        <span className="truncate">Dashboard polish</span>
      </div>
      <div className="rounded bg-success/10 px-2 py-1 text-success">+ Add the empty state</div>
      <div className="rounded bg-destructive/10 px-2 py-1 text-destructive">
        − Remove the placeholder
      </div>
      <div className="flex items-center gap-2 pt-1 text-muted-foreground">
        <ProviderIcon provider="claudeAgent" className="size-3.5 shrink-0" />
        Ask an agent to review
      </div>
    </div>
  );
}

function HubPreview() {
  return (
    <div className="flex flex-col items-center">
      <Chip active>
        <WorkflowIcon className="size-4 shrink-0" />
        Coordinator
      </Chip>
      <div className="h-3 w-px bg-border" />
      <div className="h-px w-1/2 bg-border" />
      <div className="grid w-full grid-cols-2 gap-2">
        {(["codex", "claudeAgent"] as const).map((provider) => (
          <div key={provider} className="flex min-w-0 flex-col items-center">
            <div className="h-3 w-px bg-border" />
            <Chip>
              <ProviderIcon provider={provider} className="size-4 shrink-0" />
              <span className="truncate">{provider === "codex" ? "Frontend" : "API"}</span>
            </Chip>
          </div>
        ))}
      </div>
    </div>
  );
}
