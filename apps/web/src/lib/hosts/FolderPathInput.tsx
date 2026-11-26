import type { FilesystemBrowseInput, FilesystemBrowseResult } from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../../components/ui/autocomplete";
import {
  getBrowseLeafPathSegment,
  hasTrailingPathSeparator,
  preferredPathSeparator,
} from "../projectPaths";
import { t } from "~/i18n";

export type BrowseFolders = (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;

// Use every match for the common prefix, not just the rows rendered in the popup.
function completion(paths: readonly string[], value: string): string | undefined {
  let prefix = paths[0];
  if (!prefix) return;
  if (paths.length === 1) return prefix;
  for (const path of paths) {
    while (!path.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // Never shorten the typed path when case-insensitive host matches differ in case.
  const leaf = getBrowseLeafPathSegment(value);
  const shared = getBrowseLeafPathSegment(prefix);
  return shared.length > leaf.length && shared.toLowerCase().startsWith(leaf.toLowerCase())
    ? prefix
    : undefined;
}

export function FolderPathInput({
  value,
  onChange,
  browse,
  cwd,
  onEnter,
  ...input
}: {
  value: string;
  onChange: (value: string) => void;
  browse: BrowseFolders | undefined;
  cwd?: string | undefined;
  render?: ComponentProps<typeof AutocompleteInput>["render"];
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
  id: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<{
    value: string;
    browse: BrowseFolders;
    cwd: string | undefined;
    paths: string[];
    error?: string;
  } | null>(null);
  const active = editing && !input.disabled && !!value.trim() && !!browse;
  const current =
    active && result?.value === value && result.browse === browse && result.cwd === cwd
      ? result
      : null;
  const paths = current?.paths ?? [];
  const pendingTab = useRef<{
    value: string;
    browse: BrowseFolders;
    cwd: string | undefined;
  } | null>(null);
  const highlighted = useRef<string | undefined>(undefined);
  const finishPendingTab = useEffectEvent(
    (query: string, source: BrowseFolders, base: string | undefined, matches: string[]) => {
      if (
        !active ||
        value !== query ||
        browse !== source ||
        cwd !== base ||
        pendingTab.current?.value !== query ||
        pendingTab.current.browse !== source ||
        pendingTab.current.cwd !== base
      )
        return;
      pendingTab.current = null;
      const next = completion(matches, value);
      if (next && next !== value) onChange(next);
    },
  );
  useEffect(() => {
    if (!active || !browse) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { entries } = await browse({ partialPath: value, ...(cwd ? { cwd } : {}) });
        if (cancelled) return;
        const paths = entries.map(({ fullPath }) =>
          hasTrailingPathSeparator(fullPath)
            ? fullPath
            : fullPath + preferredPathSeparator(fullPath),
        );
        setResult({ value, browse, cwd, paths });
        finishPendingTab(value, browse, cwd, paths);
      } catch (cause) {
        if (!cancelled) {
          pendingTab.current = null;
          setResult({
            value,
            browse,
            cwd,
            paths: [],
            error: describeErrorMessage(cause, t("workspace:folderSuggestionsUnavailable")),
          });
        }
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, browse, cwd, value]);

  const dismiss = () => {
    setEditing(false);
    pendingTab.current = null;
    highlighted.current = undefined;
    setResult(null);
  };
  return (
    <Autocomplete
      value={value}
      items={paths.slice(0, 24)}
      mode="none"
      open={paths.length > 0}
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key") dismiss();
      }}
      onItemHighlighted={(item) => {
        highlighted.current = item;
      }}
      onValueChange={(next) => {
        pendingTab.current = null;
        highlighted.current = undefined;
        setEditing(true);
        onChange(next);
      }}
    >
      <AutocompleteInput
        {...input}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        onBlur={dismiss}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const selected =
            highlighted.current && paths.includes(highlighted.current)
              ? highlighted.current
              : undefined;
          if (event.key === "Enter" && !selected) {
            dismiss();
            onEnter?.(event);
          }
          if (
            event.key !== "Tab" ||
            event.shiftKey ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            !value.trim() ||
            !browse
          )
            return;
          const next = selected ?? completion(paths, value);
          if (next && next !== value) {
            event.preventDefault();
            highlighted.current = undefined;
            onChange(next);
          } else if (
            !current &&
            (pendingTab.current?.value !== value ||
              pendingTab.current.browse !== browse ||
              pendingTab.current.cwd !== cwd)
          ) {
            // A fast type-then-Tab should work before the remote listing arrives.
            event.preventDefault();
            setEditing(true);
            pendingTab.current = { value, browse, cwd };
          }
        }}
      />
      {paths.length > 0 && (
        <AutocompletePopup>
          <AutocompleteList>
            {(path: string) => (
              <AutocompleteItem key={path} value={path}>
                <span className="truncate">{path}</span>
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      )}
      {current?.error && (
        <p role="status" className="mt-1 text-ui-sm text-muted-foreground">
          {current.error}
        </p>
      )}
    </Autocomplete>
  );
}
