import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { XIcon } from "~/lib/icons";
import { useProjectImportDialogStore } from "./projectImportDialogStore";
import { useProjectImportAnnouncement } from "./useProjectImportAnnouncement";

export function ProjectImportAnnouncement() {
  const { visible, markSeen } = useProjectImportAnnouncement();
  if (!visible) return null;
  return (
    <section
      aria-label="Project import is available"
      className="relative mx-2 mb-3 rounded-xl border border-primary/20 bg-primary/5 p-3"
    >
      <button
        type="button"
        aria-label="Dismiss project import announcement"
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        onClick={markSeen}
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="mb-2 flex items-center gap-2 text-primary">
        <ProviderIcon provider="codex" className="size-4" />
        <ProviderIcon provider="claudeAgent" className="size-4" />
        <span className="text-[11px] font-medium">New</span>
      </div>
      <p className="text-xs font-medium">Bring your projects with you</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Import projects and conversations from Codex and Claude Code, using the same folders.
      </p>
      <Button
        size="sm"
        variant="ghost"
        className="mt-2 h-7 px-0 text-xs"
        onClick={() => {
          markSeen();
          useProjectImportDialogStore.getState().openDialog();
        }}
      >
        Import projects…
      </Button>
    </section>
  );
}
