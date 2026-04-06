// FILE: PluginLibrary.tsx
// Purpose: Hosts the plugin and skill browser surfaced from provider discovery APIs.
// Layer: Route-level screen
// Exports: PluginLibrary

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderPluginAppSummary,
  type ProviderPluginDescriptor,
  type ProviderPluginDetail,
  type ProviderSkillDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useStore } from "~/store";
import {
  buildPluginSearchBlob,
  buildSkillSearchBlob,
  formatSkillScope,
  normalizeProviderDiscoveryText,
  resolveProviderDiscoveryCwd,
} from "~/lib/providerDiscovery";
import {
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerReadPluginQueryOptions,
  providerSkillsQueryOptions,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  HammerIcon,
  PlugIcon,
  SearchIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";

type DiscoveryTab = "plugins" | "skills";
type ProviderCapabilities = {
  plugins: boolean;
  skills: boolean;
};
type PluginEntry = {
  marketplaceName: string;
  marketplacePath: string;
  plugin: ProviderPluginDescriptor;
  isFeatured: boolean;
};

const TAB_COPY: Record<DiscoveryTab, { empty: string; placeholder: string }> = {
  plugins: {
    empty: "No plugins match this search.",
    placeholder: "Search plugins",
  },
  skills: {
    empty: "No skills match this search.",
    placeholder: "Search skills",
  },
};

function pluginEntryKey(entry: Pick<PluginEntry, "marketplacePath" | "plugin">): string {
  return `${entry.marketplacePath}::${entry.plugin.name}`;
}

function sectionTitle(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return "Unknown";
  return normalized;
}

function formatInstallPolicy(policy: ProviderPluginDescriptor["installPolicy"]): string {
  switch (policy) {
    case "INSTALLED_BY_DEFAULT":
      return "Built in";
    case "AVAILABLE":
      return "Available";
    case "NOT_AVAILABLE":
      return "Unavailable";
    default:
      return policy;
  }
}

function formatAuthPolicy(policy: ProviderPluginDescriptor["authPolicy"]): string {
  return policy === "ON_INSTALL" ? "Auth on install" : "Auth on use";
}

function resolvePluginAccent(plugin: ProviderPluginDescriptor): string | undefined {
  const color = plugin.interface?.brandColor?.trim();
  if (!color) return undefined;
  return color;
}

function PluginGlyph({ plugin }: { plugin: ProviderPluginDescriptor }) {
  const accent = resolvePluginAccent(plugin);
  return (
    <span
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-background text-sm font-semibold text-foreground shadow-xs/5"
      style={accent ? { backgroundColor: `${accent}18`, borderColor: `${accent}40` } : undefined}
    >
      <PlugIcon className="size-4.5" />
    </span>
  );
}

function ProviderToggleButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 items-center rounded-full border px-3 text-[12px] font-medium transition-colors",
        active
          ? "border-border bg-foreground text-background shadow-xs"
          : "border-border/70 bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground",
        disabled && "cursor-not-allowed opacity-45",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-foreground text-background shadow-xs"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full min-h-56 items-center justify-center rounded-[28px] border border-dashed border-border/70 bg-background/50 px-6 text-center">
      <div className="max-w-sm space-y-1.5">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-sm text-muted-foreground">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

function PluginRow({
  entry,
  active,
  onSelect,
}: {
  entry: PluginEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const description =
    entry.plugin.interface?.shortDescription ??
    entry.plugin.interface?.longDescription ??
    entry.plugin.source.path;

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-3 rounded-[24px] border px-3 py-3.5 text-left transition-colors",
        active
          ? "border-border bg-accent/65"
          : "border-transparent bg-background/45 hover:border-border/70 hover:bg-accent/35",
      )}
      onClick={onSelect}
    >
      <PluginGlyph plugin={entry.plugin} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[14px] font-medium text-foreground">
            {entry.plugin.interface?.displayName ?? entry.plugin.name}
          </p>
          {entry.isFeatured ? (
            <Badge variant="secondary" size="sm" className="rounded-full px-2">
              Featured
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant={entry.plugin.enabled ? "success" : "outline"} size="sm">
            {entry.plugin.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Badge variant="outline" size="sm">
            {formatInstallPolicy(entry.plugin.installPolicy)}
          </Badge>
        </div>
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/55 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SkillRow({ skill }: { skill: ProviderSkillDescriptor }) {
  const description =
    skill.interface?.shortDescription ?? skill.description ?? "No description available.";

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/45 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-medium text-foreground">
          {skill.interface?.displayName ?? skill.name}
        </p>
        <Badge variant={skill.enabled ? "success" : "outline"} size="sm">
          {skill.enabled ? "Enabled" : "Disabled"}
        </Badge>
        <Badge variant="outline" size="sm">
          {formatSkillScope(skill.scope)}
        </Badge>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      <code className="mt-2 block break-all text-[11px] text-muted-foreground/75">
        {skill.path}
      </code>
    </div>
  );
}

function DetailSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.14em] uppercase text-muted-foreground">
          {title}
        </h3>
        {typeof count === "number" ? (
          <Badge variant="outline" size="sm">
            {count}
          </Badge>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PluginAppRow({ app }: { app: ProviderPluginAppSummary }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/55 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-foreground">{app.name}</p>
        {app.needsAuth ? (
          <Badge variant="outline" size="sm">
            Auth
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {app.description ?? "No app description available."}
      </p>
      {app.installUrl ? (
        <a
          className="mt-2 inline-flex items-center gap-1 text-sm text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
          href={app.installUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open install page
          <ExternalLinkIcon className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function PluginDetailPanel({
  plugin,
  isLoading,
}: {
  plugin: ProviderPluginDetail | null;
  isLoading: boolean;
}) {
  if (isLoading && !plugin) {
    return (
      <div className="space-y-4 rounded-[32px] border border-border/70 bg-background/60 p-5">
        <Skeleton className="h-7 w-40 rounded-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-28 w-full rounded-[24px]" />
        <Skeleton className="h-28 w-full rounded-[24px]" />
      </div>
    );
  }

  if (!plugin) {
    return (
      <EmptyPanel
        title="Pick a plugin"
        description="Select a plugin to inspect its bundled skills, apps, and MCP servers."
      />
    );
  }

  const summary = plugin.summary;

  return (
    <div className="space-y-5 rounded-[32px] border border-border/70 bg-background/60 p-5 shadow-xs/5">
      <div className="flex items-start gap-4">
        <PluginGlyph plugin={summary} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {summary.interface?.displayName ?? summary.name}
            </h2>
            {summary.installed ? (
              <Badge variant="success">Installed</Badge>
            ) : (
              <Badge variant="outline">Not installed</Badge>
            )}
            <Badge variant={summary.enabled ? "success" : "outline"}>
              {summary.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {summary.interface?.shortDescription ??
              plugin.description ??
              "No plugin description available."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{formatInstallPolicy(summary.installPolicy)}</Badge>
            <Badge variant="outline">{formatAuthPolicy(summary.authPolicy)}</Badge>
            {summary.interface?.category ? (
              <Badge variant="outline">{summary.interface.category}</Badge>
            ) : null}
            {summary.interface?.developerName ? (
              <Badge variant="outline">{summary.interface.developerName}</Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rounded-[24px] border border-border/70 bg-background/50 px-4 py-3.5">
        <p className="text-[12px] font-semibold tracking-[0.14em] uppercase text-muted-foreground">
          Source
        </p>
        <p className="mt-2 text-sm text-foreground">{sectionTitle(plugin.marketplaceName)}</p>
        <code className="mt-1 block break-all text-[11px] text-muted-foreground/75">
          {summary.source.path}
        </code>
      </div>

      <DetailSection title="Bundled skills" count={plugin.skills.length}>
        {plugin.skills.length > 0 ? (
          <div className="space-y-3">
            {plugin.skills.map((skill) => (
              <SkillRow key={skill.path} skill={skill} />
            ))}
          </div>
        ) : (
          <EmptyPanel
            title="No bundled skills"
            description="This plugin does not expose any bundled skills through app-server."
          />
        )}
      </DetailSection>

      <DetailSection title="Apps" count={plugin.apps.length}>
        {plugin.apps.length > 0 ? (
          <div className="space-y-3">
            {plugin.apps.map((app) => (
              <PluginAppRow key={app.id} app={app} />
            ))}
          </div>
        ) : (
          <EmptyPanel
            title="No connector apps"
            description="This plugin does not bundle any app entries."
          />
        )}
      </DetailSection>

      <DetailSection title="MCP servers" count={plugin.mcpServers.length}>
        {plugin.mcpServers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {plugin.mcpServers.map((server) => (
              <Badge key={server} variant="outline" className="rounded-full px-2.5 py-1">
                <HammerIcon className="size-3.5" />
                {server}
              </Badge>
            ))}
          </div>
        ) : (
          <EmptyPanel
            title="No MCP servers"
            description="No MCP server names were returned for this plugin."
          />
        )}
      </DetailSection>
    </div>
  );
}

export function PluginLibrary() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useMemo(
    () => (routeThreadId ? (threads.find((thread) => thread.id === routeThreadId) ?? null) : null),
    [routeThreadId, threads],
  );
  const activeProject = useMemo(
    () =>
      (activeThread ? projects.find((project) => project.id === activeThread.projectId) : null) ??
      projects[0] ??
      null,
    [activeThread, projects],
  );
  const preferredProvider =
    activeThread?.modelSelection.provider ??
    activeProject?.defaultModelSelection?.provider ??
    "codex";
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>(preferredProvider);
  const [selectedTab, setSelectedTab] = useState<DiscoveryTab>("plugins");
  const [pluginSearch, setPluginSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const deferredPluginSearch = useDeferredValue(pluginSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);
  const [selectedPluginKey, setSelectedPluginKey] = useState<string | null>(null);
  const providerThreadId = routeThreadId ?? null;

  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const codexCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("codex"));
  const claudeCapabilitiesQuery = useQuery(providerComposerCapabilitiesQueryOptions("claudeAgent"));
  const providerCapabilities = useMemo<Record<ProviderKind, ProviderCapabilities>>(
    () => ({
      codex: {
        plugins: supportsPluginDiscovery(codexCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(codexCapabilitiesQuery.data),
      },
      claudeAgent: {
        plugins: supportsPluginDiscovery(claudeCapabilitiesQuery.data),
        skills: supportsSkillDiscovery(claudeCapabilitiesQuery.data),
      },
    }),
    [claudeCapabilitiesQuery.data, codexCapabilitiesQuery.data],
  );

  useEffect(() => {
    const supportsCurrentTab =
      selectedTab === "plugins"
        ? providerCapabilities[selectedProvider].plugins
        : providerCapabilities[selectedProvider].skills;
    if (supportsCurrentTab) return;

    const fallbackProvider =
      selectedTab === "plugins"
        ? providerCapabilities.codex.plugins
          ? "codex"
          : providerCapabilities.claudeAgent.plugins
            ? "claudeAgent"
            : null
        : providerCapabilities[preferredProvider].skills
          ? preferredProvider
          : providerCapabilities.codex.skills
            ? "codex"
            : providerCapabilities.claudeAgent.skills
              ? "claudeAgent"
              : null;
    if (fallbackProvider) {
      setSelectedProvider(fallbackProvider);
    }
  }, [preferredProvider, providerCapabilities, selectedProvider, selectedTab]);

  const discoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: activeThread?.worktreePath ?? null,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const providerLabel = PROVIDER_DISPLAY_NAMES[selectedProvider];
  const canListPlugins = providerCapabilities[selectedProvider].plugins;
  const canListSkills = providerCapabilities[selectedProvider].skills;

  const pluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      enabled: selectedTab === "plugins" && canListPlugins,
    }),
  );
  const skillQueryText = selectedTab === "skills" ? deferredSkillSearch : "";
  const skillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      query: skillQueryText,
      enabled: selectedTab === "skills" && canListSkills && discoveryCwd !== null,
    }),
  );
  const discoveredSkills = useMemo(
    () => skillsQuery.data?.skills ?? [],
    [skillsQuery.data?.skills],
  );

  const pluginEntries = useMemo<PluginEntry[]>(() => {
    const featuredIds = new Set(pluginsQuery.data?.featuredPluginIds ?? []);
    return (pluginsQuery.data?.marketplaces ?? []).flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
        plugin,
        isFeatured: featuredIds.has(plugin.id),
      })),
    );
  }, [pluginsQuery.data]);

  const filteredPluginEntries = useMemo(() => {
    const query = normalizeProviderDiscoveryText(deferredPluginSearch);
    if (!query) return pluginEntries;
    return pluginEntries.filter((entry) => buildPluginSearchBlob(entry.plugin).includes(query));
  }, [deferredPluginSearch, pluginEntries]);

  const featuredPluginEntries = useMemo(
    () => filteredPluginEntries.filter((entry) => entry.isFeatured),
    [filteredPluginEntries],
  );

  const marketplaceSections = useMemo(() => {
    const sections = new Map<string, { title: string; entries: PluginEntry[] }>();
    for (const entry of filteredPluginEntries) {
      const existing = sections.get(entry.marketplacePath);
      if (existing) {
        existing.entries.push(entry);
      } else {
        sections.set(entry.marketplacePath, {
          title: sectionTitle(entry.marketplaceName),
          entries: [entry],
        });
      }
    }
    return Array.from(sections.entries()).map(([key, value]) => ({
      key,
      title: value.title,
      entries: value.entries,
    }));
  }, [filteredPluginEntries]);

  useEffect(() => {
    if (selectedTab !== "plugins") return;
    if (filteredPluginEntries.length === 0) {
      setSelectedPluginKey(null);
      return;
    }
    if (
      selectedPluginKey &&
      filteredPluginEntries.some((entry) => pluginEntryKey(entry) === selectedPluginKey)
    ) {
      return;
    }
    const firstEntry = filteredPluginEntries[0];
    if (!firstEntry) return;
    setSelectedPluginKey(pluginEntryKey(firstEntry));
  }, [filteredPluginEntries, selectedPluginKey, selectedTab]);

  const selectedPluginEntry = useMemo(
    () =>
      filteredPluginEntries.find((entry) => pluginEntryKey(entry) === selectedPluginKey) ?? null,
    [filteredPluginEntries, selectedPluginKey],
  );

  const pluginDetailQuery = useQuery(
    providerReadPluginQueryOptions({
      provider: selectedProvider,
      marketplacePath: selectedPluginEntry?.marketplacePath ?? "",
      pluginName: selectedPluginEntry?.plugin.name ?? "",
      enabled: selectedTab === "plugins" && selectedPluginEntry !== null,
    }),
  );

  const filteredSkills = useMemo(() => {
    const query = normalizeProviderDiscoveryText(deferredSkillSearch);
    const skills = discoveredSkills;
    if (!query) return skills;
    return skills.filter((skill) => buildSkillSearchBlob(skill).includes(query));
  }, [deferredSkillSearch, discoveredSkills]);

  const discoveryContextLabel =
    discoveryCwd ?? "No project context available yet. Skills need a workspace path.";

  return (
    <SidebarInset className="min-h-svh bg-background">
      <div className="flex min-h-svh flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-border/70 border-b px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <SidebarTrigger className="shrink-0 md:hidden" />
            <div>
              <p className="text-lg font-semibold tracking-tight text-foreground">
                Plugins & skills
              </p>
              <p className="text-sm text-muted-foreground">
                Powered by {providerLabel} discovery in the active workspace context.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ProviderToggleButton
              label="Codex"
              active={selectedProvider === "codex"}
              disabled={
                selectedTab === "plugins"
                  ? !providerCapabilities.codex.plugins
                  : !providerCapabilities.codex.skills
              }
              onClick={() => {
                setSelectedProvider("codex");
              }}
            />
            <ProviderToggleButton
              label="Claude"
              active={selectedProvider === "claudeAgent"}
              disabled={
                selectedTab === "plugins"
                  ? !providerCapabilities.claudeAgent.plugins
                  : !providerCapabilities.claudeAgent.skills
              }
              onClick={() => {
                setSelectedProvider("claudeAgent");
              }}
            />
          </div>
        </header>

        <div className="flex-1 px-4 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-full border border-border/70 bg-background/80 p-1">
                <TabButton
                  label="Plugins"
                  active={selectedTab === "plugins"}
                  onClick={() => {
                    setSelectedTab("plugins");
                  }}
                />
                <TabButton
                  label="Skills"
                  active={selectedTab === "skills"}
                  onClick={() => {
                    setSelectedTab("skills");
                  }}
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className="max-w-full rounded-full px-2.5">
                  {providerLabel}
                </Badge>
                <Badge variant="outline" className="max-w-full rounded-full px-2.5">
                  {selectedTab === "plugins" ? "Plugin discovery" : "Skill discovery"}
                </Badge>
                {discoveryCwd ? (
                  <Badge
                    variant="outline"
                    className="max-w-[28rem] truncate rounded-full px-2.5"
                    title={discoveryCwd}
                  >
                    {discoveryCwd}
                  </Badge>
                ) : null}
              </div>
            </div>

            <InputGroup className="max-w-3xl rounded-[20px] bg-background/80">
              <InputGroupAddon>
                <InputGroupText>
                  <SearchIcon className="size-4" />
                </InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={selectedTab === "plugins" ? pluginSearch : skillSearch}
                onChange={(event) => {
                  if (selectedTab === "plugins") {
                    setPluginSearch(event.target.value);
                    return;
                  }
                  setSkillSearch(event.target.value);
                }}
                placeholder={TAB_COPY[selectedTab].placeholder}
                aria-label={TAB_COPY[selectedTab].placeholder}
              />
            </InputGroup>

            {!discoveryCwd && selectedTab === "skills" ? (
              <InlineWarning>
                `skills/list` needs a workspace path. Open a project or thread to browse skills for
                that context.
              </InlineWarning>
            ) : null}

            {selectedTab === "plugins" && pluginsQuery.data?.remoteSyncError ? (
              <InlineWarning>{pluginsQuery.data.remoteSyncError}</InlineWarning>
            ) : null}

            {selectedTab === "plugins" &&
            (pluginsQuery.data?.marketplaceLoadErrors.length ?? 0) > 0 ? (
              <InlineWarning>
                {pluginsQuery.data?.marketplaceLoadErrors
                  .map((error) => `${sectionTitle(error.marketplacePath)}: ${error.message}`)
                  .join(" • ")}
              </InlineWarning>
            ) : null}

            {selectedTab === "plugins" ? (
              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(22rem,0.85fr)]">
                <section className="min-h-0 space-y-4 overflow-y-auto pr-1">
                  {!canListPlugins ? (
                    <EmptyPanel
                      title={`Plugins are unavailable for ${providerLabel}`}
                      description="This provider does not expose plugin discovery through the current runtime."
                    />
                  ) : pluginsQuery.isLoading && pluginEntries.length === 0 ? (
                    <div className="space-y-3">
                      {[
                        "plugin-skeleton-1",
                        "plugin-skeleton-2",
                        "plugin-skeleton-3",
                        "plugin-skeleton-4",
                      ].map((key) => (
                        <Skeleton key={key} className="h-28 w-full rounded-[24px]" />
                      ))}
                    </div>
                  ) : filteredPluginEntries.length === 0 ? (
                    <EmptyPanel title="No plugins found" description={TAB_COPY.plugins.empty} />
                  ) : (
                    <>
                      {featuredPluginEntries.length > 0 ? (
                        <DetailSection title="Featured" count={featuredPluginEntries.length}>
                          <div className="space-y-3">
                            {featuredPluginEntries.map((entry) => (
                              <PluginRow
                                key={`featured:${pluginEntryKey(entry)}`}
                                entry={entry}
                                active={pluginEntryKey(entry) === selectedPluginKey}
                                onSelect={() => {
                                  setSelectedPluginKey(pluginEntryKey(entry));
                                }}
                              />
                            ))}
                          </div>
                        </DetailSection>
                      ) : null}

                      <div className="space-y-5">
                        {marketplaceSections.map((section) => (
                          <DetailSection
                            key={section.key}
                            title={section.title}
                            count={section.entries.length}
                          >
                            <div className="space-y-3">
                              {section.entries.map((entry) => (
                                <PluginRow
                                  key={pluginEntryKey(entry)}
                                  entry={entry}
                                  active={pluginEntryKey(entry) === selectedPluginKey}
                                  onSelect={() => {
                                    setSelectedPluginKey(pluginEntryKey(entry));
                                  }}
                                />
                              ))}
                            </div>
                          </DetailSection>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <aside className="min-h-0 overflow-y-auto pl-0 lg:pl-1">
                  <PluginDetailPanel
                    plugin={pluginDetailQuery.data?.plugin ?? null}
                    isLoading={pluginDetailQuery.isLoading}
                  />
                </aside>
              </div>
            ) : (
              <section className="min-h-0 flex-1 overflow-y-auto pr-1">
                {!canListSkills ? (
                  <EmptyPanel
                    title={`Skills are unavailable for ${providerLabel}`}
                    description="This provider does not expose skill discovery through the current runtime."
                  />
                ) : skillsQuery.isLoading && discoveredSkills.length === 0 ? (
                  <div className="space-y-3">
                    {[
                      "skill-skeleton-1",
                      "skill-skeleton-2",
                      "skill-skeleton-3",
                      "skill-skeleton-4",
                      "skill-skeleton-5",
                    ].map((key) => (
                      <Skeleton key={key} className="h-28 w-full rounded-[24px]" />
                    ))}
                  </div>
                ) : filteredSkills.length === 0 ? (
                  <EmptyPanel title="No skills found" description={TAB_COPY.skills.empty} />
                ) : (
                  <div className="space-y-3">
                    {filteredSkills.map((skill) => (
                      <SkillRow key={skill.path} skill={skill} />
                    ))}
                  </div>
                )}
              </section>
            )}

            <footer className="border-border/70 border-t pt-3">
              <p className="text-sm text-muted-foreground">
                Context: <span className="text-foreground/80">{discoveryContextLabel}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground/75">
                Plugins come from `plugin/list`, plugin detail from `plugin/read`, and the skills
                tab from `skills/list`.
              </p>
            </footer>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
