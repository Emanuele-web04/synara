import { useContext, useSyncExternalStore } from "react";
import { BugReportIcon, CircleAlertIcon, CodeIcon, KeyboardIcon, SkillCubeIcon } from "~/lib/icons";
import { ExplorerActivityBarButton } from "../chat/workspaceExplorer";
import { EditorToolScopeContext, type EditorTool } from "./editorToolScope";

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => null;
const tools = [
  { id: "outline", label: "Outline", Icon: CodeIcon },
  { id: "problems", label: "Problems", Icon: CircleAlertIcon },
  { id: "debug", label: "Run and debug", Icon: BugReportIcon },
] as const;

/** Extends the existing inner rail; actions reuse the active native editor's pickers. */
export function EditorToolsActivityBar({ onManageExtensions }: { onManageExtensions: () => void }) {
  const scope = useContext(EditorToolScopeContext);
  const target = useSyncExternalStore(
    scope?.subscribe ?? subscribeEmpty,
    scope?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const available = (tool: EditorTool) => Boolean(target?.available.includes(tool));
  return (
    <>
      <div
        role="group"
        aria-label="Editor tools"
        className="mt-2 w-full shrink-0 border-t border-border/65 py-2"
      >
        {tools.map(({ id, label, Icon }) => {
          const enabled = available(id);
          const count = id === "problems" ? (target?.problemCount ?? 0) : 0;
          const title = !target
            ? `${label} — open a code file`
            : !enabled
              ? `${label} — unavailable for this file`
              : label;
          return (
            <ExplorerActivityBarButton
              key={id}
              label={title}
              active={target?.selected === id}
              disabled={!enabled}
              onClick={() => target?.open(id)}
            >
              <Icon className="size-5" />
              {count > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 min-w-4 rounded-full bg-destructive px-1 text-center text-ui-xs font-medium text-destructive-foreground tabular-nums"
                >
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
              {count > 0 ? <span className="sr-only">{count} problems in this file</span> : null}
              {id === "debug" && target?.debugging ? (
                <span
                  className="absolute right-2 top-2 size-1.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              ) : null}
            </ExplorerActivityBarButton>
          );
        })}
      </div>
      <div
        role="group"
        aria-label="Extension tools and commands"
        className="mt-auto w-full shrink-0 border-t border-border/65 py-2"
      >
        <ExplorerActivityBarButton
          label="Editor extensions"
          active={target?.selected === "extensions"}
          onClick={() =>
            target ? target.open("extensions", onManageExtensions) : onManageExtensions()
          }
        >
          <SkillCubeIcon className="size-5" />
        </ExplorerActivityBarButton>
        <ExplorerActivityBarButton
          label={target ? "Editor commands" : "Editor commands — open a code file"}
          active={target?.selected === "commands"}
          disabled={!available("commands")}
          onClick={() => target?.open("commands")}
        >
          <KeyboardIcon className="size-5" />
        </ExplorerActivityBarButton>
      </div>
    </>
  );
}
