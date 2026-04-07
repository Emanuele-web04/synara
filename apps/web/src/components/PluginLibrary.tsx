// FILE: PluginLibrary.tsx
// Purpose: Hosts the plugin and skill browser surfaced from provider discovery APIs.
// Layer: Route-level screen
// Exports: PluginLibrary

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import React, { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useStore } from "~/store";
import {
  buildPluginSearchBlob,
  buildSkillSearchBlob,
  normalizeProviderDiscoveryText,
  resolveProviderDiscoveryCwd,
} from "~/lib/providerDiscovery";
import {
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
} from "~/lib/providerDiscoveryReactQuery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  HammerIcon,
  ListChecksIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./ui/input-group";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";

// ── Types ──────────────────────────────────────────────────────────────────

type DiscoveryTab = "plugins" | "skills";
type ProviderCapabilities = { plugins: boolean; skills: boolean };
type PluginEntry = {
  marketplaceName: string;
  marketplacePath: string;
  plugin: ProviderPluginDescriptor;
  isFeatured: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_ICON: Record<ProviderKind, React.FC<React.SVGProps<SVGSVGElement>>> = {
  codex: HammerIcon,
  claudeAgent: BotIcon,
};

// ── Utilities ──────────────────────────────────────────────────────────────

function pluginEntryKey(entry: Pick<PluginEntry, "marketplacePath" | "plugin">): string {
  return `${entry.marketplacePath}::${entry.plugin.name}`;
}

function sectionTitle(value: string): string {
  const n = value.trim();
  return n.length === 0 ? "Unknown" : n;
}

function resolvePluginAccent(plugin: ProviderPluginDescriptor): string | undefined {
  return plugin.interface?.brandColor?.trim() || undefined;
}

/** Stable hue 0–359 from a string, for consistent per-item icon colors. */
function nameToHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

// ── Icon glyphs ────────────────────────────────────────────────────────────

function PluginGlyph({ plugin }: { plugin: ProviderPluginDescriptor }) {
  const accent = resolvePluginAccent(plugin);
  const hue = nameToHue(plugin.interface?.displayName ?? plugin.name);
  const style = accent
    ? {
        background: `linear-gradient(145deg, ${accent}cc, ${accent}77)`,
        boxShadow: `0 0 0 0.5px ${accent}35`,
      }
    : {
        background: `linear-gradient(145deg, hsl(${hue} 55% 30%), hsl(${hue} 45% 18%))`,
        boxShadow: `0 0 0 0.5px hsl(${hue} 40% 30% / 0.35)`,
      };
  return (
    <span
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px]"
      style={style}
    >
      <PlugIcon className="size-5 text-white/80" />
    </span>
  );
}

function SkillGlyph({ skill }: { skill: ProviderSkillDescriptor }) {
  const hue = nameToHue(skill.interface?.displayName ?? skill.name);
  return (
    <span
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[14px]"
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 55% 30%), hsl(${hue} 45% 18%))`,
        boxShadow: `0 0 0 0.5px hsl(${hue} 40% 30% / 0.35)`,
      }}
    >
      <ListChecksIcon className="size-5 text-white/80" />
    </span>
  );
}

// ── UI controls ────────────────────────────────────────────────────────────

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
        "inline-flex h-10 items-center border-b-2 px-1 text-[13px] font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/80",
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ProviderToggleButton({
  label,
  active,
  disabled,
  onClick,
  provider,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  provider: ProviderKind;
}) {
  const Icon = PROVIDER_ICON[provider] ?? HammerIcon;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-foreground text-background shadow-xs"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        disabled && "pointer-events-none opacity-35",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      <Icon className="size-3.5 shrink-0" />
      {label}
    </button>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/60 bg-background/40 px-5 py-6 text-center">
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/6 px-3 py-2.5 text-xs text-muted-foreground">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

function ActionIcon({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
        active
          ? "border-border/40 text-muted-foreground/50"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {active ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
    </span>
  );
}

// ── Grid items ─────────────────────────────────────────────────────────────

function PluginGridItem({ entry }: { entry: PluginEntry }) {
  const description =
    entry.plugin.interface?.shortDescription ??
    entry.plugin.interface?.longDescription ??
    entry.plugin.source.path;

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-accent/25">
      <PluginGlyph plugin={entry.plugin} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">
          {entry.plugin.interface?.displayName ?? entry.plugin.name}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      <ActionIcon active={entry.plugin.enabled} />
    </div>
  );
}

function SkillGridItem({ skill }: { skill: ProviderSkillDescriptor }) {
  const description =
    skill.interface?.shortDescription ?? skill.description ?? "No description available.";

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-accent/25">
      <SkillGlyph skill={skill} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">
          {skill.interface?.displayName ?? skill.name}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      <ActionIcon active={skill.enabled} />
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="px-3 pb-1 pt-2 text-[15px] font-semibold text-foreground">{title}</h2>;
}

// ── Main component ─────────────────────────────────────────────────────────

export function PluginLibrary() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useMemo(
    () => (routeThreadId ? (threads.find((t) => t.id === routeThreadId) ?? null) : null),
    [routeThreadId, threads],
  );
  const activeProject = useMemo(
    () =>
      (activeThread ? projects.find((p) => p.id === activeThread.projectId) : null) ??
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

  // Auto-fallback: switch provider when current tab/provider combo is unsupported
  useEffect(() => {
    const supportsTab =
      selectedTab === "plugins"
        ? providerCapabilities[selectedProvider].plugins
        : providerCapabilities[selectedProvider].skills;
    if (supportsTab) return;
    const fallback =
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
    if (fallback) setSelectedProvider(fallback);
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

  const skillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: discoveryCwd,
      threadId: providerThreadId,
      query: selectedTab === "skills" ? deferredSkillSearch : "",
      enabled: selectedTab === "skills" && canListSkills && discoveryCwd !== null,
    }),
  );

  const discoveredSkills = useMemo(
    () => skillsQuery.data?.skills ?? [],
    [skillsQuery.data?.skills],
  );

  const pluginEntries = useMemo<PluginEntry[]>(() => {
    const featuredIds = new Set(pluginsQuery.data?.featuredPluginIds ?? []);
    return (pluginsQuery.data?.marketplaces ?? []).flatMap((m) =>
      m.plugins.map((plugin) => ({
        marketplaceName: m.name,
        marketplacePath: m.path,
        plugin,
        isFeatured: featuredIds.has(plugin.id),
      })),
    );
  }, [pluginsQuery.data]);

  const filteredPluginEntries = useMemo(() => {
    const q = normalizeProviderDiscoveryText(deferredPluginSearch);
    if (!q) return pluginEntries;
    return pluginEntries.filter((e) => buildPluginSearchBlob(e.plugin).includes(q));
  }, [deferredPluginSearch, pluginEntries]);

  const featuredPluginEntries = useMemo(
    () => filteredPluginEntries.filter((e) => e.isFeatured),
    [filteredPluginEntries],
  );

  const marketplaceSections = useMemo(() => {
    const map = new Map<string, { title: string; entries: PluginEntry[] }>();
    for (const entry of filteredPluginEntries) {
      const existing = map.get(entry.marketplacePath);
      if (existing) {
        existing.entries.push(entry);
      } else {
        map.set(entry.marketplacePath, {
          title: sectionTitle(entry.marketplaceName),
          entries: [entry],
        });
      }
    }
    return Array.from(map.entries()).map(([key, v]) => ({
      key,
      title: v.title,
      entries: v.entries,
    }));
  }, [filteredPluginEntries]);

  const filteredSkills = useMemo(() => {
    const q = normalizeProviderDiscoveryText(deferredSkillSearch);
    if (!q) return discoveredSkills;
    return discoveredSkills.filter((s) => buildSkillSearchBlob(s).includes(q));
  }, [deferredSkillSearch, discoveredSkills]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background isolate">
      <div className="flex h-full flex-col">
        {/* ── Top nav ───────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="flex items-end gap-3">
            <TabButton
              label="Plugins"
              active={selectedTab === "plugins"}
              onClick={() => setSelectedTab("plugins")}
            />
            <TabButton
              label="Skills"
              active={selectedTab === "skills"}
              onClick={() => setSelectedTab("skills")}
            />
          </div>
          <div className="flex-1" />
          <div className="inline-flex rounded-full border border-border/60 bg-background/60 p-0.5">
            <ProviderToggleButton
              label="Codex"
              provider="codex"
              active={selectedProvider === "codex"}
              disabled={!providerCapabilities.codex.plugins && !providerCapabilities.codex.skills}
              onClick={() => {
                setSelectedProvider("codex");
                if (
                  selectedTab === "skills" &&
                  !providerCapabilities.codex.skills &&
                  providerCapabilities.codex.plugins
                )
                  setSelectedTab("plugins");
              }}
            />
            <ProviderToggleButton
              label="Claude"
              provider="claudeAgent"
              active={selectedProvider === "claudeAgent"}
              disabled={
                !providerCapabilities.claudeAgent.plugins &&
                !providerCapabilities.claudeAgent.skills
              }
              onClick={() => {
                setSelectedProvider("claudeAgent");
                if (
                  selectedTab === "plugins" &&
                  !providerCapabilities.claudeAgent.plugins &&
                  providerCapabilities.claudeAgent.skills
                )
                  setSelectedTab("skills");
              }}
            />
          </div>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Hero */}
          <div className="px-6 py-10 text-center">
            <h1 className="text-[28px] font-semibold tracking-tight text-foreground">
              Make {providerLabel} work your way
            </h1>
          </div>

          {/* Search */}
          <div className="mx-auto max-w-2xl px-6 pb-6">
            <InputGroup className="rounded-xl bg-background/70 shadow-xs">
              <InputGroupAddon>
                <InputGroupText>
                  <SearchIcon className="size-4 text-muted-foreground/60" />
                </InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={selectedTab === "plugins" ? pluginSearch : skillSearch}
                onChange={(e) => {
                  if (selectedTab === "plugins") setPluginSearch(e.target.value);
                  else setSkillSearch(e.target.value);
                }}
                placeholder={selectedTab === "plugins" ? "Search plugins" : "Search skills"}
                className="text-sm"
              />
            </InputGroup>
          </div>

          {/* Warnings */}
          {((!discoveryCwd && selectedTab === "skills") ||
            (selectedTab === "plugins" && !!pluginsQuery.data?.remoteSyncError) ||
            (selectedTab === "plugins" &&
              (pluginsQuery.data?.marketplaceLoadErrors.length ?? 0) > 0)) && (
            <div className="mx-auto max-w-2xl space-y-1.5 px-6 pb-4">
              {!discoveryCwd && selectedTab === "skills" ? (
                <InlineWarning>
                  Skills need a workspace path. Open a project or thread first.
                </InlineWarning>
              ) : null}
              {selectedTab === "plugins" && pluginsQuery.data?.remoteSyncError ? (
                <InlineWarning>{pluginsQuery.data.remoteSyncError}</InlineWarning>
              ) : null}
              {selectedTab === "plugins" &&
              (pluginsQuery.data?.marketplaceLoadErrors.length ?? 0) > 0 ? (
                <InlineWarning>
                  {pluginsQuery.data?.marketplaceLoadErrors
                    .map((err) => `${sectionTitle(err.marketplacePath)}: ${err.message}`)
                    .join(" • ")}
                </InlineWarning>
              ) : null}
            </div>
          )}

          {/* Grid content */}
          <div className="px-3 pb-10 sm:px-5">
            {selectedTab === "plugins" ? (
              <>
                {!canListPlugins ? (
                  <div className="mx-auto max-w-2xl">
                    <EmptyPanel
                      title={`Plugins unavailable for ${providerLabel}`}
                      description="This provider does not expose plugin discovery."
                    />
                  </div>
                ) : pluginsQuery.isLoading && pluginEntries.length === 0 ? (
                  <div className="space-y-1">
                    {["1", "2", "3", "4", "5", "6"].map((k) => (
                      <Skeleton key={k} className="h-[68px] w-full rounded-xl" />
                    ))}
                  </div>
                ) : filteredPluginEntries.length === 0 ? (
                  <EmptyPanel
                    title="No plugins found"
                    description="No plugins match this search."
                  />
                ) : (
                  <div className="space-y-6">
                    {featuredPluginEntries.length > 0 && (
                      <div>
                        <SectionHeader title="Featured" />
                        <div className="grid grid-cols-1 sm:grid-cols-2">
                          {featuredPluginEntries.map((entry) => (
                            <PluginGridItem key={`f:${pluginEntryKey(entry)}`} entry={entry} />
                          ))}
                        </div>
                      </div>
                    )}
                    {marketplaceSections.map((section) => (
                      <div key={section.key}>
                        <SectionHeader title={section.title} />
                        <div className="grid grid-cols-1 sm:grid-cols-2">
                          {section.entries.map((entry) => (
                            <PluginGridItem key={pluginEntryKey(entry)} entry={entry} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {!canListSkills ? (
                  <div className="mx-auto max-w-2xl">
                    <EmptyPanel
                      title={`Skills unavailable for ${providerLabel}`}
                      description="This provider does not expose skill discovery."
                    />
                  </div>
                ) : skillsQuery.isLoading && discoveredSkills.length === 0 ? (
                  <div className="space-y-1">
                    {["1", "2", "3", "4", "5", "6"].map((k) => (
                      <Skeleton key={k} className="h-[68px] w-full rounded-xl" />
                    ))}
                  </div>
                ) : filteredSkills.length === 0 ? (
                  <EmptyPanel title="No skills found" description="No skills match this search." />
                ) : (
                  <div>
                    <SectionHeader title="Skills" />
                    <div className="grid grid-cols-1 sm:grid-cols-2">
                      {filteredSkills.map((skill) => (
                        <SkillGridItem key={skill.path} skill={skill} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
