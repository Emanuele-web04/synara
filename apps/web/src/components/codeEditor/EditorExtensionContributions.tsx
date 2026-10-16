import { Button } from "../ui/button";
import type {
  ExtensionContributions,
  ExtensionContributionsSnapshot,
} from "./extensionContributions";

/** Only visible while an enabled extension has contextual status or live work. */
export function EditorExtensionContributions({
  snapshot,
  controller,
  onError,
}: {
  snapshot: ExtensionContributionsSnapshot;
  controller: ExtensionContributions;
  onError: (error: unknown) => void;
}) {
  if (!snapshot.progress.length && !snapshot.status.length) return null;
  return (
    <div className="max-h-28 shrink-0 overflow-auto border-t border-border px-3 py-1 text-ui-sm text-muted-foreground">
      {snapshot.progress.map((progress) => (
        <div key={progress.handle} role="status" className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {progress.title}
            {progress.message ? ` · ${progress.message}` : ""}
          </span>
          <progress
            className="h-1 w-20"
            max={100}
            {...(progress.value === null ? {} : { value: progress.value })}
            aria-label={progress.title}
          />
          {progress.cancellable ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void controller.cancel(progress.handle).catch(onError);
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ))}
      {snapshot.status.map((status) =>
        status.actionable ? (
          <Button
            key={status.id}
            size="xs"
            variant="ghost"
            title={status.detail}
            onClick={() => {
              void controller.chooseStatus(status.id).catch(onError);
            }}
          >
            {status.label}
          </Button>
        ) : (
          <span
            key={status.id}
            title={status.detail}
            className="mr-3 inline-block max-w-full truncate"
          >
            {status.label}
          </span>
        ),
      )}
    </div>
  );
}
