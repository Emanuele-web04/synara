import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  EditorExtensionSummary,
  EditorExtensionsInput,
  EditorExtensionsResult,
} from "@synara/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectItem } from "~/components/ui/select";
import {
  CodeIcon,
  PluginIcon,
  BugIcon,
  CheckIcon,
  DownloadIcon,
  SearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
} from "~/lib/icons";
import { SettingsCard, SettingsEmptyState, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { requestEditorExtensions } from "./editorExtensionsApi";

type Extension = EditorExtensionsResult["registryResults"][number];
type Sort = NonNullable<EditorExtensionsInput["sortBy"]>;
type Category = NonNullable<EditorExtensionsInput["category"]>;
const categories: readonly { value: Category | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "Programming Languages", label: "Languages" },
  { value: "Formatters", label: "Formatters" },
  { value: "Linters", label: "Linters" },
  { value: "Debuggers", label: "Debuggers" },
];
const sorts: readonly { value: Sort; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "downloadCount", label: "Most downloaded" },
  { value: "timestamp", label: "Recently updated" },
];
const count = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const idOf = (extension: Extension) => `${extension.namespace}.${extension.name}`.toLowerCase();

function ExtensionGlyph({ extension }: { extension: Extension }) {
  const Icon = extension.categories?.includes("Debuggers")
    ? BugIcon
    : extension.categories?.includes("Programming Languages") ||
        extension.categories?.includes("Formatters")
      ? CodeIcon
      : PluginIcon;
  return (
    <span
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 text-foreground"
    >
      <Icon className="size-5" />
    </span>
  );
}

function CatalogLoading() {
  return (
    <div role="status" aria-label="Loading extension catalog">
      <span className="sr-only">Loading extension catalog…</span>
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <SettingsCard key={index} divided={false} className="space-y-4 p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-11 rounded-xl" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-7 w-24" />
          </SettingsCard>
        ))}
      </div>
    </div>
  );
}

type MarketplaceProps = {
  entries: readonly EditorExtensionSummary[];
  busy: boolean;
  available: boolean;
  pendingId: string | undefined;
  active: boolean;
  operationError: string | null;
  onInstall: (id: string, version?: string) => void;
  onManage: () => void;
};

/** Live Open VSX data in Synara's own cards, inputs, sheets and theme tokens. */
export function ExtensionMarketplace(props: MarketplaceProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [sortBy, setSortBy] = useState<Sort>("downloadCount");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Extension | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const moveToResults = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettledQuery(query.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  const catalog = useQuery({
    queryKey: ["editor-extension-catalog", settledQuery, category, sortBy, offset],
    queryFn: ({ signal }) =>
      requestEditorExtensions(
        {
          operation: "catalog",
          query: settledQuery,
          sortBy,
          offset,
          ...(category ? { category } : {}),
        },
        signal,
      ),
    enabled: props.active && props.available,
    staleTime: 60_000,
    retry: false,
  });
  const details = useQuery({
    queryKey: ["editor-extension-details", selected ? idOf(selected) : null],
    queryFn: ({ signal }) =>
      requestEditorExtensions({ operation: "details", id: idOf(selected!) }, signal),
    enabled: selected !== null,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (moveToResults.current && catalog.isSuccess && !catalog.isFetching) {
      moveToResults.current = false;
      resultHeading.current?.focus();
    }
  }, [catalog.isSuccess, catalog.isFetching, offset]);
  const changing = query.trim() !== settledQuery;
  const results = catalog.data?.registryResults ?? [];
  const registryTotal = catalog.data?.registryTotal;
  const nextOffset = catalog.data?.registryNextOffset;
  const detailsItem = details.data?.registryDetails;
  const selectedInstalled = selected
    ? props.entries.find((entry) => entry.id === idOf(selected))
    : undefined;
  const closeDetails = () => {
    setSelected(null);
    requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
  };
  const resetFilters = () => {
    setQuery("");
    setSettledQuery("");
    setCategory("");
    setOffset(0);
  };
  const title = settledQuery
    ? `Results for “${settledQuery}”`
    : category
      ? categories.find((item) => item.value === category)!.label
      : "Explore extensions";

  return (
    <div className="space-y-5" data-testid="extension-marketplace">
      <SettingsCard divided={false} className="overflow-hidden p-5">
        <div className="flex items-start gap-4">
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40"
            aria-hidden="true"
          >
            <PluginIcon className="size-6" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-ui-sm font-medium text-muted-foreground">
              OPEN VSX · EDITOR EXTENSIONS
            </p>
            <h2 className="text-ui-lg font-semibold text-foreground">Tools for the way you code</h2>
            <p className="text-ui text-muted-foreground">
              Discover formatters, languages and debugging tools. Your editor stays Synara.
            </p>
          </div>
        </div>
        <p className="mt-4 border-t border-border pt-3 text-ui-sm text-muted-foreground">
          Install first, approve separately. A catalog listing does not guarantee Synara
          compatibility.
        </p>
      </SettingsCard>

      <div className="space-y-3">
        <form
          className="flex gap-2"
          role="search"
          aria-label="Extension catalog"
          onSubmit={(event) => {
            event.preventDefault();
            setSettledQuery(query.trim());
            setOffset(0);
            if (query.trim() === settledQuery && offset === 0) void catalog.refetch();
          }}
        >
          <div className="relative min-w-0 flex-1">
            <label className="sr-only" htmlFor={searchId}>
              Search Open VSX
            </label>
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              value={query}
              maxLength={256}
              className="pl-9"
              placeholder="Search extensions, languages or publishers"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!props.available}>
            Search
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Extension category">
            {categories.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant={category === item.value ? "secondary" : "ghost"}
                aria-pressed={category === item.value}
                onClick={() => {
                  setCategory(item.value);
                  setOffset(0);
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <Select
            value={sortBy}
            onValueChange={(value) => {
              if (sorts.some((item) => item.value === value)) {
                setSortBy(value as Sort);
                setOffset(0);
              }
            }}
            items={sorts}
          >
            <SelectTrigger aria-label="Sort extensions" size="sm" className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SettingsSelectPopup>
              {sorts.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SettingsSelectPopup>
          </Select>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            ref={resultHeading}
            tabIndex={-1}
            className="break-words text-ui font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h2>
          <p role="status" aria-live="polite" className="mt-1 text-ui-sm text-muted-foreground">
            {changing || catalog.isFetching
              ? "Updating catalog…"
              : registryTotal !== undefined
                ? `${registryTotal.toLocaleString()} results on Open VSX`
                : "Browse the Open VSX catalog"}
          </p>
        </div>
        {query || category ? (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {catalog.error ? (
        <SettingsEmptyState tone="destructive" layout="status">
          <div role="alert" className="space-y-3">
            <p className="font-medium">The catalog could not be loaded</p>
            <p>{catalog.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={catalog.isFetching}
              onClick={() => void catalog.refetch()}
            >
              Try again
            </Button>
          </div>
        </SettingsEmptyState>
      ) : null}
      {!props.available ? (
        <SettingsEmptyState layout="status">
          Connect to the Synara server to browse extensions. Installed packages remain managed by
          that server.
        </SettingsEmptyState>
      ) : !catalog.data && catalog.isPending ? (
        <CatalogLoading />
      ) : !catalog.error && results.length === 0 ? (
        <SettingsEmptyState>
          <SearchIcon className="mx-auto mb-3 size-6" />
          <p className="font-medium text-foreground">No matching extensions</p>
          <p className="mt-1">Try another name, publisher or category.</p>
        </SettingsEmptyState>
      ) : (
        <ul
          aria-label="Extension results"
          aria-busy={catalog.isFetching || changing}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {results.map((extension) => {
            const id = idOf(extension),
              installed = props.entries.find((entry) => entry.id === id);
            const pending = props.busy && props.pendingId === id;
            return (
              <li key={id} data-testid="extension-card" className="min-w-0">
                <SettingsCard divided={false} className="flex h-full min-w-0 flex-col p-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <ExtensionGlyph extension={extension} />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        className="max-w-full rounded-sm text-left text-ui font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Details for ${extension.displayName || id}`}
                        onClick={(event) => {
                          returnFocus.current = event.currentTarget;
                          setSelected(extension);
                        }}
                      >
                        <span className="line-clamp-2 break-words">
                          {extension.displayName || extension.name}
                        </span>
                      </button>
                      <p className="mt-1 truncate text-ui-sm text-muted-foreground" title={id}>
                        {id}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-10 text-ui text-muted-foreground">
                    {extension.description || "No description provided by the publisher."}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <span
                      className="inline-flex items-center gap-1 text-ui-sm text-muted-foreground"
                      title={
                        extension.downloadCount === undefined
                          ? undefined
                          : `${extension.downloadCount.toLocaleString()} downloads on Open VSX`
                      }
                    >
                      {extension.downloadCount !== undefined ? (
                        <>
                          <DownloadIcon aria-hidden="true" className="size-3.5" />
                          {count.format(extension.downloadCount)} downloads
                        </>
                      ) : (
                        <>v{extension.version}</>
                      )}
                    </span>
                    {installed ? (
                      <Button size="sm" variant="outline" onClick={props.onManage}>
                        <CheckIcon aria-hidden="true" className="size-3.5" />
                        {installed.enabled ? "Enabled" : "Installed"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={props.busy || changing || catalog.isFetching}
                        onClick={() => props.onInstall(id)}
                      >
                        {pending ? "Installing…" : "Install"}
                      </Button>
                    )}
                  </div>
                  {pending ? (
                    <p role="status" className="mt-2 text-ui-sm text-muted-foreground">
                      Downloading and validating package…
                    </p>
                  ) : null}
                </SettingsCard>
              </li>
            );
          })}
        </ul>
      )}
      {offset > 0 || nextOffset !== undefined ? (
        <nav
          aria-label="Extension result pages"
          className="flex items-center justify-between gap-3 border-t border-border pt-4"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0 || catalog.isFetching || changing}
            onClick={() => {
              moveToResults.current = true;
              setOffset(Math.max(0, offset - 24));
            }}
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
            Previous
          </Button>
          <span className="text-ui-sm text-muted-foreground">
            Page {Math.floor(offset / 24) + 1}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={nextOffset === undefined || catalog.isFetching || changing}
            onClick={() => {
              if (nextOffset !== undefined) {
                moveToResults.current = true;
                setOffset(nextOffset);
              }
            }}
          >
            Next
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </Button>
        </nav>
      ) : null}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) closeDetails();
        }}
      >
        <DialogPopup className="max-w-xl" showCloseButton={false}>
          {selected ? (
            <>
              <DialogHeader>
                <div className="flex items-start gap-3">
                  <ExtensionGlyph extension={detailsItem ?? selected} />
                  <div className="min-w-0">
                    <DialogTitle className="break-words">
                      {selected.displayName || selected.name}
                    </DialogTitle>
                    <DialogDescription className="break-all">{idOf(selected)}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <p className="whitespace-pre-wrap break-words text-ui text-muted-foreground">
                  {detailsItem?.description ??
                    selected.description ??
                    "No description provided by the publisher."}
                </p>
                {details.isPending ? (
                  <p role="status" className="text-ui text-muted-foreground">
                    Checking compatible package details…
                  </p>
                ) : null}
                {details.error ? (
                  <div role="alert" className="space-y-2 text-ui text-destructive">
                    <p>{details.error.message}</p>
                    <Button variant="outline" size="sm" onClick={() => void details.refetch()}>
                      Retry details
                    </Button>
                  </div>
                ) : null}
                {detailsItem ? (
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl border border-border p-4 text-ui">
                    <div>
                      <dt className="text-ui-sm text-muted-foreground">Compatible package</dt>
                      <dd className="mt-1 break-all font-medium">{detailsItem.version}</dd>
                    </div>
                    <div>
                      <dt className="text-ui-sm text-muted-foreground">Publisher</dt>
                      <dd className="mt-1 break-all font-medium">{detailsItem.namespace}</dd>
                    </div>
                    <div>
                      <dt className="text-ui-sm text-muted-foreground">VS Code API requirement</dt>
                      <dd className="mt-1 break-all">{detailsItem.apiRange ?? "Not provided"}</dd>
                    </div>
                    <div>
                      <dt className="text-ui-sm text-muted-foreground">License</dt>
                      <dd className="mt-1 break-words">{detailsItem.license ?? "Not provided"}</dd>
                    </div>
                    {detailsItem.categories?.length ? (
                      <div className="col-span-2">
                        <dt className="text-ui-sm text-muted-foreground">Categories</dt>
                        <dd className="mt-1">{detailsItem.categories.join(" · ")}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-ui-sm text-muted-foreground">
                  <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p>
                    API-version compatibility is not full VS Code compatibility. Execution currently
                    requires a supported Linux sandbox. Installations stay disabled until you
                    approve the package and trust its workspace.
                  </p>
                </div>
              </DialogPanel>
              {props.operationError ? (
                <p role="alert" className="px-4 text-ui text-destructive">
                  {props.operationError}
                </p>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={closeDetails}>
                  Close
                </Button>
                {selectedInstalled ? (
                  <Button
                    onClick={() => {
                      closeDetails();
                      props.onManage();
                    }}
                  >
                    Manage installed extension
                  </Button>
                ) : (
                  <Button
                    disabled={props.busy || !detailsItem || details.isFetching || details.isError}
                    onClick={() =>
                      detailsItem && props.onInstall(idOf(detailsItem), detailsItem.version)
                    }
                  >
                    {props.busy && props.pendingId === idOf(selected)
                      ? "Installing…"
                      : "Install compatible version"}
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
