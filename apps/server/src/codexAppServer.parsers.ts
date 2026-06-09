// Purpose: Pure readers/parsers/classifiers over Codex app-server JSON-RPC
//   payloads — record/array/string/boolean accessors, JSON-RPC message-shape
//   guards, route-field extraction, thread/skill/plugin/model response parsing,
//   and review-item detection.
// Layer: Pure functions over plain data. No process handles, no manager state,
//   no I/O. Depends only on protocol id helpers, config, types, and contracts.
// Exports: see individual `export function` declarations below.
import type {
  ProviderItemId,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderPluginAppSummary,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderRequestKind,
  ProviderSkillDescriptor,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";

import { toProviderItemId, toTurnId } from "./codexAppServer.protocol.ts";
import type {
  CodexAppServerReviewTarget,
  CodexThreadSnapshot,
  CodexThreadTurnSnapshot,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./codexAppServer.types.ts";

export function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

export function readArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return Array.isArray(target) ? target : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

export function readFirstBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = readBoolean(value, key);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

export function requestKindForMethod(method: string): ProviderRequestKind | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }

  if (method === "item/fileRead/requestApproval") {
    return "file-read";
  }

  if (method === "item/fileChange/requestApproval") {
    return "file-change";
  }

  return undefined;
}

export function readThreadIdFromResponse(method: string, response: unknown): string {
  const responseRecord = readObject(response);
  const thread = readObject(responseRecord, "thread");
  const threadIdRaw = readString(thread, "id") ?? readString(responseRecord, "threadId");
  if (!threadIdRaw) {
    throw new Error(`${method} response did not include a thread id.`);
  }
  return threadIdRaw;
}

export function parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
  const responseRecord = readObject(response);
  const threadRecord = readObject(responseRecord, "thread");
  const threadIdRaw = readThreadIdFromResponse(method, responseRecord);
  const turnsRaw = readArray(threadRecord, "turns") ?? readArray(responseRecord, "turns") ?? [];
  const turns = turnsRaw.map((turnValue, index) => {
    const turn = readObject(turnValue);
    const turnIdRaw = readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    const items = readArray(turn, "items") ?? [];
    return {
      id: turnId,
      items,
    };
  });

  return {
    threadId: threadIdRaw,
    turns,
    cwd: readString(threadRecord, "cwd") ?? readString(responseRecord, "cwd") ?? null,
  };
}

export function toCodexReviewTarget(target: CodexAppServerReviewTarget): Record<string, unknown> {
  switch (target.type) {
    case "uncommittedChanges":
      return {
        type: "uncommittedChanges",
      };
    case "baseBranch":
      return {
        type: "baseBranch",
        branch: target.branch,
      };
  }
}

export function isServerRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.method === "string" &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

export function isServerNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && !("id" in candidate);
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
  const hasMethod = typeof candidate.method === "string";
  return hasId && !hasMethod;
}

export function readRouteFields(params: unknown): {
  turnId?: TurnId;
  itemId?: ProviderItemId;
} {
  const route: {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } = {};

  const turnId = toTurnId(
    readString(params, "turnId") ?? readString(readObject(params, "turn"), "id"),
  );
  const itemId = toProviderItemId(
    readString(params, "itemId") ?? readString(readObject(params, "item"), "id"),
  );

  if (turnId) {
    route.turnId = turnId;
  }

  if (itemId) {
    route.itemId = itemId;
  }

  return route;
}

export function readProviderConversationId(params: unknown): string | undefined {
  return (
    readString(params, "threadId") ??
    readString(readObject(params, "thread"), "id") ??
    readString(params, "conversationId")
  );
}

export function isExitedReviewModeNotification(notification: JsonRpcNotification): boolean {
  if (notification.method !== "item/completed") {
    return false;
  }
  const item = readObject(notification.params, "item");
  const itemType = readString(item, "type") ?? readString(item, "kind");
  return itemType === "exitedReviewMode";
}

export function isTurnInterruptTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Timed out waiting for turn/interrupt");
}

export function normalizeItemType(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function turnHasReviewItem(
  turn: CodexThreadTurnSnapshot,
  itemType: "entered" | "exited",
): boolean {
  return turn.items.some((item) => {
    const record = readObject(item);
    const normalized = normalizeItemType(
      readString(record, "type") ?? readString(record, "kind"),
    );
    return itemType === "entered"
      ? normalized.includes("entered review mode")
      : normalized.includes("exited review mode");
  });
}

export function findLatestReviewTurnId(snapshot: CodexThreadSnapshot): TurnId | undefined {
  const latestReviewTurn = [...snapshot.turns]
    .toReversed()
    .find((turn) => turnHasReviewItem(turn, "entered"));
  return latestReviewTurn?.id;
}

export function isExitedReviewTurn(snapshot: CodexThreadSnapshot, turnId: TurnId): boolean {
  const turn = snapshot.turns.find((entry) => entry.id === turnId);
  return turn ? turnHasReviewItem(turn, "exited") : false;
}

export function parseSkillDescriptor(skill: unknown): ProviderSkillDescriptor | undefined {
  const record = readObject(skill);
  if (!record) return undefined;
  const name = readString(record, "name")?.trim();
  const path = readString(record, "path")?.trim();
  if (!name || !path) {
    return undefined;
  }
  const description = readString(record, "description")?.trim();
  const scope = readString(record, "scope")?.trim();
  const display = readObject(record, "interface");
  return {
    name,
    path,
    enabled: record.enabled !== false,
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
    ...(display
      ? {
          interface: {
            ...(readString(display, "displayName")
              ? { displayName: readString(display, "displayName") }
              : {}),
            ...(readString(display, "shortDescription")
              ? {
                  shortDescription: readString(display, "shortDescription"),
                }
              : {}),
          },
        }
      : {}),
    ...(record.dependencies !== undefined ? { dependencies: record.dependencies } : {}),
  } satisfies ProviderSkillDescriptor;
}

export function parseSkillsListResponse(response: unknown, cwd: string): ProviderSkillDescriptor[] {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const dataItems = readArray(resultRecord, "data") ?? [];
  const scopedData = dataItems.find((value) => {
    const item = readObject(value);
    const itemCwd = readString(item, "cwd");
    return itemCwd === cwd;
  });
  const scopedSkills = readArray(readObject(scopedData), "skills");
  const directSkills = readArray(resultRecord, "skills");
  const rawSkills = scopedSkills ?? directSkills ?? [];

  const parsedSkills = rawSkills.flatMap((skill) => {
    const parsedSkill = parseSkillDescriptor(skill);
    return parsedSkill ? [parsedSkill] : [];
  });

  return parsedSkills.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function parsePluginListResponse(
  response: unknown,
): Omit<ProviderListPluginsResult, "source" | "cached"> {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const marketplaces = (readArray(resultRecord, "marketplaces") ?? []).flatMap((marketplace) => {
    const record = readObject(marketplace);
    if (!record) return [];
    const name = readString(record, "name")?.trim();
    const path = readString(record, "path")?.trim();
    if (!name || !path) {
      return [];
    }
    const rawPlugins = readArray(record, "plugins") ?? [];
    const plugins = rawPlugins.flatMap((plugin) => {
      const parsedPlugin = parsePluginSummary(plugin);
      return parsedPlugin ? [parsedPlugin] : [];
    });
    const marketplaceInterface = readObject(record, "interface");
    const marketplaceDisplayName = readString(marketplaceInterface, "displayName")?.trim();
    return [
      {
        name,
        path,
        ...(marketplaceDisplayName
          ? {
              interface: {
                displayName: marketplaceDisplayName,
              },
            }
          : {}),
        plugins,
      },
    ];
  });
  const marketplaceLoadErrors = (readArray(resultRecord, "marketplaceLoadErrors") ?? [])
    .map((error) => readObject(error))
    .flatMap((error) => {
      if (!error) return [];
      const marketplacePath = readString(error, "marketplacePath")?.trim();
      const message = readString(error, "message")?.trim();
      if (!marketplacePath || !message) {
        return [];
      }
      return [{ marketplacePath, message }];
    });
  const featuredPluginIds = (readArray(resultRecord, "featuredPluginIds") ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const remoteSyncError = readString(resultRecord, "remoteSyncError")?.trim() ?? null;

  return {
    marketplaces,
    marketplaceLoadErrors,
    remoteSyncError: remoteSyncError?.length ? remoteSyncError : null,
    featuredPluginIds,
  };
}

export function parsePluginSummary(plugin: unknown): ProviderPluginDescriptor | undefined {
  const record = readObject(plugin);
  if (!record) return undefined;
  const id = readString(record, "id")?.trim();
  const name = readString(record, "name")?.trim();
  const source = readObject(record, "source");
  const sourcePath = readString(source, "path")?.trim();
  const installPolicy = readString(record, "installPolicy");
  const authPolicy = readString(record, "authPolicy");
  if (
    !id ||
    !name ||
    !sourcePath ||
    (installPolicy !== "NOT_AVAILABLE" &&
      installPolicy !== "AVAILABLE" &&
      installPolicy !== "INSTALLED_BY_DEFAULT") ||
    (authPolicy !== "ON_INSTALL" && authPolicy !== "ON_USE")
  ) {
    return undefined;
  }

  const pluginInterface = parsePluginInterface(readObject(record, "interface"));

  return {
    id,
    name,
    source: {
      type: "local",
      path: sourcePath,
    },
    installed: record.installed === true,
    enabled: record.enabled === true,
    installPolicy,
    authPolicy,
    ...(pluginInterface ? { interface: pluginInterface } : {}),
  } satisfies ProviderPluginDescriptor;
}

export function parsePluginInterface(
  value: unknown,
): ProviderPluginDescriptor["interface"] | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const capabilities = (readArray(record, "capabilities") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  const defaultPrompt = (readArray(record, "defaultPrompt") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  const screenshots = (readArray(record, "screenshots") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return {
    ...(readString(record, "displayName")?.trim()
      ? { displayName: readString(record, "displayName")?.trim() }
      : {}),
    ...(readString(record, "shortDescription")?.trim()
      ? {
          shortDescription: readString(record, "shortDescription")?.trim(),
        }
      : {}),
    ...(readString(record, "longDescription")?.trim()
      ? {
          longDescription: readString(record, "longDescription")?.trim(),
        }
      : {}),
    ...(readString(record, "developerName")?.trim()
      ? { developerName: readString(record, "developerName")?.trim() }
      : {}),
    ...(readString(record, "category")?.trim()
      ? { category: readString(record, "category")?.trim() }
      : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(readString(record, "websiteUrl")?.trim()
      ? { websiteUrl: readString(record, "websiteUrl")?.trim() }
      : {}),
    ...(readString(record, "privacyPolicyUrl")?.trim()
      ? {
          privacyPolicyUrl: readString(record, "privacyPolicyUrl")?.trim(),
        }
      : {}),
    ...(readString(record, "termsOfServiceUrl")?.trim()
      ? {
          termsOfServiceUrl: readString(record, "termsOfServiceUrl")?.trim(),
        }
      : {}),
    ...(defaultPrompt.length > 0 ? { defaultPrompt } : {}),
    ...(readString(record, "brandColor")?.trim()
      ? { brandColor: readString(record, "brandColor")?.trim() }
      : {}),
    ...(readString(record, "composerIcon")?.trim()
      ? { composerIcon: readString(record, "composerIcon")?.trim() }
      : {}),
    ...(readString(record, "logo")?.trim() ? { logo: readString(record, "logo")?.trim() } : {}),
    ...(screenshots.length > 0 ? { screenshots } : {}),
  };
}

export function parsePluginReadResponse(response: unknown): ProviderPluginDetail {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const pluginRecord = readObject(resultRecord, "plugin") ?? resultRecord;
  const marketplaceName = readString(pluginRecord, "marketplaceName")?.trim();
  const marketplacePath = readString(pluginRecord, "marketplacePath")?.trim();
  const summary = parsePluginSummary(readObject(pluginRecord, "summary"));
  if (!marketplaceName || !marketplacePath || !summary) {
    throw new Error("plugin/read response did not include a valid plugin payload.");
  }
  const skills = (readArray(pluginRecord, "skills") ?? []).flatMap((skill) => {
    const parsedSkill = parseSkillDescriptor(skill);
    return parsedSkill ? [parsedSkill] : [];
  });
  const apps = (readArray(pluginRecord, "apps") ?? []).flatMap((app) => {
    const parsedApp = parsePluginAppSummary(app);
    return parsedApp ? [parsedApp] : [];
  });
  const mcpServers = (readArray(pluginRecord, "mcpServers") ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const description = readString(pluginRecord, "description")?.trim();

  return {
    marketplaceName,
    marketplacePath,
    summary,
    ...(description ? { description } : {}),
    skills,
    apps,
    mcpServers,
  };
}

export function parsePluginAppSummary(value: unknown): ProviderPluginAppSummary | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const id = readString(record, "id")?.trim();
  const name = readString(record, "name")?.trim();
  if (!id || !name) {
    return undefined;
  }
  const description = readString(record, "description")?.trim();
  const installUrl = readString(record, "installUrl")?.trim();
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(installUrl ? { installUrl } : {}),
    needsAuth: record.needsAuth === true,
  };
}

export function parseModelListResponse(response: unknown): ProviderListModelsResult["models"] {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const rawModels =
    readArray(resultRecord, "items") ??
    readArray(resultRecord, "data") ??
    readArray(resultRecord, "models") ??
    [];
  const seen = new Set<string>();

  return rawModels.flatMap((value) => {
    const model = readObject(value);
    if (!model) {
      return [];
    }

    const slug =
      readString(model, "id") ?? readString(model, "slug") ?? readString(model, "model");
    const trimmedSlug = slug?.trim();
    if (!trimmedSlug) {
      return [];
    }

    const name =
      readString(model, "name") ??
      readString(model, "displayName") ??
      readString(model, "display_name") ??
      trimmedSlug;
    const trimmedName = name.trim();
    if (!trimmedName || seen.has(trimmedSlug)) {
      return [];
    }

    // Accept both Synara's legacy string array and Remodex-style reasoning objects.
    const supportedReasoningEfforts = Array.from(
      new Map(
        (
          readArray(model, "supportedReasoningEfforts") ??
          readArray(model, "supported_reasoning_efforts") ??
          []
        )
          .flatMap((entry) => {
            if (typeof entry === "string") {
              const value = entry.trim();
              return value.length > 0 ? [{ value }] : [];
            }

            const descriptor = readObject(entry);
            if (!descriptor) {
              return [];
            }

            const value =
              readString(descriptor, "reasoningEffort") ??
              readString(descriptor, "reasoning_effort") ??
              readString(descriptor, "value");
            const trimmedValue = value?.trim();
            if (!trimmedValue) {
              return [];
            }

            const label =
              readString(descriptor, "description") ?? readString(descriptor, "label");
            const trimmedLabel = label?.trim();
            return [
              {
                value: trimmedValue,
                ...(trimmedLabel ? { description: trimmedLabel } : {}),
              },
            ];
          })
          .map((descriptor) => [descriptor.value, descriptor] as const),
      ).values(),
    );
    const defaultReasoningEffort =
      readString(model, "defaultReasoningEffort") ??
      readString(model, "default_reasoning_effort");
    const trimmedDefaultReasoningEffort = defaultReasoningEffort?.trim();
    const additionalSpeedTiers =
      readArray(model, "additionalSpeedTiers") ??
      readArray(model, "additional_speed_tiers") ??
      [];
    const hasFastSpeedTier = additionalSpeedTiers.some(
      (tier) => typeof tier === "string" && tier.trim().toLowerCase() === "fast",
    );
    const supportsFastMode =
      readFirstBoolean(model, [
        "supportsFastMode",
        "supports_fast_mode",
        "fastMode",
        "fast_mode",
        "fastServiceTier",
        "fast_service_tier",
      ]) ?? (hasFastSpeedTier ? true : undefined);

    seen.add(trimmedSlug);
    return [
      {
        slug: trimmedSlug,
        name: trimmedName,
        ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
        ...(trimmedDefaultReasoningEffort &&
        supportedReasoningEfforts.some(
          (descriptor) => descriptor.value === trimmedDefaultReasoningEffort,
        )
          ? { defaultReasoningEffort: trimmedDefaultReasoningEffort }
          : {}),
        ...(supportsFastMode !== undefined ? { supportsFastMode } : {}),
      },
    ];
  });
}
