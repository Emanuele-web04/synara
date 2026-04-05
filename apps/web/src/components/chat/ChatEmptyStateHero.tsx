import { TerminalIcon } from "~/lib/icons";
import { memo } from "react";

export const ChatEmptyStateHero = memo(function ChatEmptyStateHero({
  projectName,
}: {
  projectName: string | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-6 select-none">
      <div className="flex size-14 items-center justify-center rounded-full border-2 border-border bg-transparent">
        <TerminalIcon className="size-6 text-border" />
      </div>

      <div className="flex flex-col items-center gap-0.5">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground/90">Let's build</h1>
        {projectName && <span className="text-lg text-muted-foreground/40">{projectName}</span>}
      </div>
    </div>
  );
});
