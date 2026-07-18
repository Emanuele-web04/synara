import type {
  GitHubAccountSelection,
  GitHubAccountSummary,
  GitHubRepositorySummary,
} from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { FiGithub, FiLock } from "react-icons/fi";
import { ArchiveIcon, CheckIcon, SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SlidingSegmentedControl, SlidingSegmentedPanelGroup } from "./ui/SlidingSegmentedControl";
import { Spinner } from "./ui/spinner";

interface GitHubProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClone: (repository: string, account: GitHubAccountSelection) => Promise<void>;
  onListAccounts: () => Promise<readonly GitHubAccountSummary[]>;
  onListRepositories: (
    account: GitHubAccountSelection,
  ) => Promise<readonly GitHubRepositorySummary[]>;
}

type RepositoryEntryMode = "search" | "paste";

const REPOSITORY_ENTRY_OPTIONS = [
  { value: "search", label: "Search GitHub" },
  { value: "paste", label: "Paste URL" },
] as const satisfies readonly { value: RepositoryEntryMode; label: string }[];

const CONTEXTUAL_ICON_MOTION_CLASS =
  "transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

const TEXT_SWAP_MOTION_CLASS =
  "transition-[opacity,transform] duration-150 ease-in-out motion-reduce:transition-none";

function githubAccountKey(account: Pick<GitHubAccountSummary, "host" | "login">): string {
  return `${account.host}/${account.login}`;
}

export function filterGitHubRepositories(
  repositories: readonly GitHubRepositorySummary[],
  query: string,
): readonly GitHubRepositorySummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return repositories;
  return repositories.filter((repository) =>
    [repository.nameWithOwner, repository.description, repository.defaultBranch]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function GitHubProjectDialog({
  open,
  onOpenChange,
  onClone,
  onListAccounts,
  onListRepositories,
}: GitHubProjectDialogProps) {
  const pasteInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [entryMode, setEntryMode] = useState<RepositoryEntryMode>("search");
  const [pastedRepository, setPastedRepository] = useState("");
  const [selectedRepository, setSelectedRepository] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [accounts, setAccounts] = useState<readonly GitHubAccountSummary[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<GitHubAccountSummary | null>(null);
  const [repositories, setRepositories] = useState<readonly GitHubRepositorySummary[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [isLoadingRepositories, setIsLoadingRepositories] = useState(false);
  const [accountListError, setAccountListError] = useState<string | null>(null);
  const [repositoryListError, setRepositoryListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCloning, setIsCloning] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntryMode("search");
    setPastedRepository("");
    setSelectedRepository("");
    setRepositoryQuery("");
    setAccounts([]);
    setSelectedAccount(null);
    setRepositories([]);
    setAccountListError(null);
    setRepositoryListError(null);
    setError(null);
    setIsCloning(false);
    setIsLoadingAccounts(true);
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    void onListAccounts()
      .then((nextAccounts) => {
        if (cancelled) return;
        setAccounts(nextAccounts);
        setSelectedAccount(
          nextAccounts.find((account) => account.active) ?? nextAccounts[0] ?? null,
        );
      })
      .catch((cause) => {
        if (cancelled) return;
        setAccountListError(
          cause instanceof Error ? cause.message : "GitHub accounts could not be loaded.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAccounts(false);
      });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [onListAccounts, open]);

  useEffect(() => {
    if (!open || !selectedAccount) return;
    let cancelled = false;
    setPastedRepository("");
    setSelectedRepository("");
    setRepositories([]);
    setRepositoryListError(null);
    setIsLoadingRepositories(true);
    void onListRepositories({ host: selectedAccount.host, login: selectedAccount.login })
      .then((nextRepositories) => {
        if (!cancelled) setRepositories(nextRepositories);
      })
      .catch((cause) => {
        if (cancelled) return;
        setRepositoryListError(
          cause instanceof Error ? cause.message : "GitHub repositories could not be loaded.",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingRepositories(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onListRepositories, open, selectedAccount]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const nextInput = entryMode === "search" ? searchInputRef.current : pasteInputRef.current;
      nextInput?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entryMode, open]);

  const filteredRepositories = useMemo(
    () => filterGitHubRepositories(repositories, repositoryQuery),
    [repositories, repositoryQuery],
  );

  const repository = entryMode === "search" ? selectedRepository : pastedRepository;

  const cloneRepository = async (candidate = repository) => {
    const trimmedRepository = candidate.trim();
    if (!trimmedRepository || !selectedAccount || isCloning) return;
    setIsCloning(true);
    setError(null);
    try {
      await onClone(trimmedRepository, {
        host: selectedAccount.host,
        login: selectedAccount.login,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The repository could not be cloned.");
    } finally {
      setIsCloning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCloning) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup
        surface="solid"
        backdropClassName="transition-opacity duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-ending-style:duration-150 motion-reduce:transition-none"
        className="github-project-dialog max-w-lg duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-ending-style:duration-150 data-ending-style:scale-[0.96] data-starting-style:scale-[0.96] motion-reduce:transition-none [&>[data-slot=dialog-close]]:end-3 [&>[data-slot=dialog-close]]:top-3 [&>[data-slot=dialog-close]]:size-10"
      >
        <DialogHeader className="gap-2 px-5 pt-5 pb-2 pe-14" data-github-dialog-reveal="1">
          <DialogTitle className="flex items-center gap-2.5 text-[length:calc(var(--app-font-size-ui-lg,13px)*1.25)] text-balance">
            <FiGithub className="size-4.5 shrink-0 text-foreground/90" />
            Add GitHub project
          </DialogTitle>
          <DialogDescription className="max-w-[58ch] text-pretty leading-relaxed">
            Choose a signed-in GitHub account, then search its repositories or paste a repository
            URL. Synara keeps the managed checkout out of your way.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4 px-5 pb-4 !pt-3" data-github-dialog-reveal="2">
          <SlidingSegmentedControl
            value={entryMode}
            options={REPOSITORY_ENTRY_OPTIONS}
            ariaLabel="Repository input"
            className="min-h-10 rounded-xl bg-muted/60 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.055)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.28)]"
            pillClassName="top-1 h-[calc(100%-0.5rem)] rounded-lg bg-background shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_-6px_rgba(0,0,0,0.28),inset_0_0_0_1px_rgba(0,0,0,0.035)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.38),0_5px_14px_-7px_rgba(0,0,0,0.8),inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            optionClassName="rounded-lg py-2 font-medium"
            onValueChange={(mode) => {
              setEntryMode(mode);
              setError(null);
            }}
          />

          <div className="grid gap-2">
            <span className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-none text-foreground">
              GitHub account
            </span>
            <Select
              value={selectedAccount ? githubAccountKey(selectedAccount) : ""}
              disabled={isLoadingAccounts || accounts.length === 0 || isCloning}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                const nextAccount = accounts.find((account) => githubAccountKey(account) === value);
                setSelectedAccount(nextAccount ?? null);
                setRepositoryQuery("");
                setError(null);
              }}
            >
              <SelectTrigger className="w-full" aria-label="GitHub account">
                <SelectValue
                  placeholder={
                    isLoadingAccounts ? "Loading GitHub accounts…" : "No signed-in accounts"
                  }
                >
                  {selectedAccount?.login}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} className="min-w-[var(--anchor-width)] p-1">
                {accounts.map((account) => (
                  <SelectItem key={githubAccountKey(account)} value={githubAccountKey(account)}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{account.login}</span>
                      {account.host !== "github.com" ? (
                        <span className="truncate text-muted-foreground">{account.host}</span>
                      ) : null}
                      {account.active ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          CLI active
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {accountListError ? (
              <span
                role="alert"
                className="rounded-lg bg-destructive/8 px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-destructive"
              >
                {accountListError}
              </span>
            ) : null}
          </div>

          <SlidingSegmentedPanelGroup
            value={entryMode}
            panels={[
              {
                value: "search",
                ariaLabel: "Search GitHub repositories",
                content: (
                  <div className="grid gap-2.5">
                    <label className="grid gap-2">
                      <span className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-none text-foreground">
                        Repository
                      </span>
                      <span className="relative block">
                        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          ref={searchInputRef}
                          type="search"
                          value={repositoryQuery}
                          placeholder="Search repositories and owners"
                          className="[&_input]:pl-8"
                          onChange={(event) => {
                            setRepositoryQuery(event.target.value);
                            setError(null);
                          }}
                        />
                      </span>
                    </label>

                    <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-background/35 p-1.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.035)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]">
                      {isLoadingRepositories ? (
                        <div className="flex items-center justify-center gap-2 px-3 py-10 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                          <Spinner className="size-3.5" />
                          Loading your repositories…
                        </div>
                      ) : repositoryListError ? (
                        <div className="grid justify-items-start gap-2 px-3 py-5 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
                          <p className="text-pretty">{repositoryListError}</p>
                          <button
                            type="button"
                            className="font-medium text-foreground hover:underline"
                            onClick={() => setEntryMode("paste")}
                          >
                            Paste a repository instead
                          </button>
                        </div>
                      ) : filteredRepositories.length === 0 ? (
                        <div className="px-3 py-10 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-pretty text-muted-foreground">
                          {repositories.length === 0
                            ? `No repositories are available to ${selectedAccount?.login ?? "this GitHub account"}.`
                            : "No repositories match your search."}
                        </div>
                      ) : (
                        <div className="grid gap-0.5">
                          {filteredRepositories.map((item) => {
                            const selected = selectedRepository === item.nameWithOwner;
                            return (
                              <button
                                key={item.nameWithOwner}
                                type="button"
                                aria-pressed={selected}
                                className={cn(
                                  "grid min-w-0 grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg px-3 py-2.5 text-left outline-none transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:ring-1 focus-visible:ring-ring/60 motion-reduce:transition-none",
                                  selected
                                    ? "bg-[var(--color-background-elevated-secondary)] text-foreground ring-1 ring-inset ring-foreground/8"
                                    : "text-foreground hover:bg-[var(--color-background-elevated-secondary)]/65",
                                )}
                                onClick={() => {
                                  setSelectedRepository(item.nameWithOwner);
                                  setError(null);
                                }}
                              >
                                <span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium leading-4">
                                  {item.nameWithOwner}
                                </span>
                                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                                  {item.isPrivate ? (
                                    <FiLock className="size-3" aria-label="Private" />
                                  ) : null}
                                  {item.isArchived ? (
                                    <ArchiveIcon className="size-3" aria-label="Archived" />
                                  ) : null}
                                  <CheckIcon
                                    aria-hidden="true"
                                    className={cn(
                                      "size-3 text-foreground",
                                      CONTEXTUAL_ICON_MOTION_CLASS,
                                      selected
                                        ? "scale-100 opacity-100 blur-0"
                                        : "scale-[0.25] opacity-0 blur-[4px]",
                                    )}
                                  />
                                </span>
                                <span className="min-w-0 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-4 text-muted-foreground">
                                  {item.description || item.defaultBranch || "GitHub repository"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                value: "paste",
                ariaLabel: "Paste a GitHub repository",
                content: (
                  <label className="grid gap-2">
                    <span className="text-[length:var(--app-font-size-ui,12px)] font-medium leading-none text-foreground">
                      Repository URL or owner/name
                    </span>
                    <Input
                      ref={pasteInputRef}
                      value={pastedRepository}
                      placeholder="github.com/owner/repository"
                      aria-describedby={error ? "github-project-error" : "github-project-location"}
                      onChange={(event) => {
                        setPastedRepository(event.target.value);
                        setError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void cloneRepository();
                        }
                      }}
                    />
                  </label>
                ),
              },
            ]}
          />

          <p
            id="github-project-location"
            className="border-t border-border/70 pt-3 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-pretty text-muted-foreground"
          >
            Synara reuses managed checkouts from <code>~/.synara/repositories</code>. You can choose
            a branch when creating the first workspace.
          </p>
          {error ? (
            <p
              id="github-project-error"
              role="alert"
              className="rounded-lg bg-destructive/8 px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-pretty text-destructive"
            >
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter
          className="px-5 pt-1 pb-5 [&_[data-slot=button]]:!font-medium"
          data-github-dialog-reveal="3"
        >
          <Button
            variant="ghost"
            className="transition-[transform,color,background-color] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none"
            onClick={() => onOpenChange(false)}
            disabled={isCloning}
          >
            Cancel
          </Button>
          <Button
            aria-label={isCloning ? "Cloning repository" : "Clone repository"}
            className="transition-[transform,background-color,opacity] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none"
            onClick={() => void cloneRepository()}
            disabled={!repository.trim() || !selectedAccount || isCloning}
          >
            <span aria-hidden="true" className="relative size-3.5">
              <FiGithub
                className={cn(
                  "absolute inset-0 size-3.5",
                  CONTEXTUAL_ICON_MOTION_CLASS,
                  isCloning ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0",
                )}
              />
              <Spinner
                className={cn(
                  "absolute inset-0 size-3.5",
                  CONTEXTUAL_ICON_MOTION_CLASS,
                  isCloning ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]",
                )}
              />
            </span>
            <span aria-hidden="true" className="grid">
              <span
                className={cn(
                  "col-start-1 row-start-1",
                  TEXT_SWAP_MOTION_CLASS,
                  isCloning ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100",
                )}
              >
                Clone repository
              </span>
              <span
                className={cn(
                  "col-start-1 row-start-1",
                  TEXT_SWAP_MOTION_CLASS,
                  isCloning ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
                )}
              >
                Cloning…
              </span>
            </span>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
