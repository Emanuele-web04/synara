import type {
  Agent,
  Command,
  Model,
  Path,
  Provider,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import {
  v2Array,
  v2Boolean,
  v2Data,
  v2Number,
  v2Object,
  v2OptionalNumber,
  v2OptionalObject,
  v2OptionalString,
  v2String,
  v2Strings,
} from "./openCodeV2Json.ts";

import { normalizeOpenCodeV2PermissionRules } from "./openCodeV2Permissions.ts";
export {
  normalizeOpenCodeV2Permission,
  normalizeOpenCodeV2Permissions,
  normalizeOpenCodeV2PermissionRules,
} from "./openCodeV2Permissions.ts";

export { normalizeOpenCodeV2Session } from "./openCodeV2Session.ts";
export { normalizeOpenCodeV2Messages } from "./openCodeV2Messages.ts";
export {
  normalizeOpenCodeV2Form,
  normalizeOpenCodeV2Questions,
  normalizeOpenCodeV2FormAnswers,
  normalizeOpenCodeV2FormReply,
} from "./openCodeV2Forms.ts";

const modalities = (value: unknown): Model["capabilities"]["input"] => {
  const list = v2Strings(value ?? [], "model modalities");
  return {
    text: list.includes("text"),
    image: list.includes("image"),
    audio: list.includes("audio"),
    video: list.includes("video"),
    pdf: list.includes("pdf"),
  };
};

function normalizeModel(value: unknown): Model {
  const model = v2Object(value, "model");
  const id = v2String(model.id, "model.id");
  const limit = v2Object(model.limit, "model.limit");
  const capabilities = v2Object(model.capabilities, "model.capabilities");
  const compatibility = v2OptionalObject(model.compatibility);
  const inputLimit = v2OptionalNumber(limit.input);
  const released = v2OptionalObject(model.time).released;
  const family = v2OptionalString(model.family);
  const cost = v2Array(model.cost ?? [], "model.cost").map((entry) => {
    const item = v2Object(entry, "model cost");
    const cache = v2Object(item.cache, "model cost cache");
    const tier = item.tier === undefined ? undefined : v2Object(item.tier, "model cost tier");
    if (tier && tier.type !== "context") throw new Error("Invalid OpenCode v2 model cost tier");
    return {
      input: v2Number(item.input, "cost.input"),
      output: v2Number(item.output, "cost.output"),
      cache: {
        read: v2Number(cache.read, "cost.cache.read"),
        write: v2Number(cache.write, "cost.cache.write"),
      },
      ...(tier
        ? { tier: { type: "context" as const, size: v2Number(tier.size, "cost.tier.size") } }
        : {}),
    };
  });
  const variants = Object.fromEntries(
    v2Array(model.variants ?? [], "model.variants").map((entry) => {
      const variant = v2Object(entry, "model variant");
      return [v2String(variant.id, "variant.id"), v2OptionalObject(variant.settings)];
    }),
  );
  const status = model.status ?? "active";
  if (status !== "active" && status !== "alpha" && status !== "beta" && status !== "deprecated") {
    throw new Error("Invalid OpenCode v2 model.status");
  }
  return {
    id,
    providerID: v2String(model.providerID, "model.providerID"),
    name: v2String(model.name, "model.name"),
    ...(family === undefined ? {} : { family }),
    api: {
      id: v2String(model.modelID ?? id, "model.modelID"),
      url: "",
      npm: v2OptionalString(model.package) ?? "",
    },
    capabilities: {
      temperature: false,
      reasoning:
        compatibility.requireReasoning === true || typeof compatibility.reasoningField === "string",
      attachment: v2Strings(capabilities.input, "model.capabilities.input").some(
        (type) => type !== "text",
      ),
      toolcall: v2Boolean(capabilities.tools, "model.capabilities.tools"),
      input: modalities(capabilities.input),
      output: modalities(capabilities.output),
      interleaved:
        typeof compatibility.reasoningField === "string"
          ? { field: compatibility.reasoningField }
          : false,
    },
    limit: {
      context: v2Number(limit.context, "model.limit.context"),
      output: v2Number(limit.output, "model.limit.output"),
      ...(inputLimit === undefined ? {} : { input: inputLimit }),
    },
    cost: {
      ...(cost.find((entry) => entry.tier === undefined) ??
        cost[0] ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }),
      tiers: cost.flatMap((entry) => (entry.tier ? [{ ...entry, tier: entry.tier }] : [])),
    },
    status,
    options: v2OptionalObject(model.settings),
    headers: Object.fromEntries(
      Object.entries(v2OptionalObject(model.headers)).map(([key, value]) => [
        key,
        v2String(value, "model header"),
      ]),
    ),
    release_date:
      typeof released === "number"
        ? new Date(v2Number(released, "model released")).toISOString().slice(0, 10)
        : "",
    variants,
  };
}

export function normalizeOpenCodeV2ProviderList(
  models: unknown,
  providers?: unknown,
): ProviderListResponse {
  const providerInfo = new Map(
    (providers === undefined ? [] : v2Array(providers, "providers")).map((entry) => {
      const provider = v2Object(entry, "provider");
      return [v2String(provider.id, "provider.id"), provider] as const;
    }),
  );
  const grouped = new Map<string, Provider>();
  for (const entry of v2Array(models, "models")) {
    const value = v2Object(entry, "model");
    if (!v2Boolean(value.enabled ?? true, "model.enabled")) continue;
    const model = normalizeModel(value);
    const info = providerInfo.get(model.providerID);
    if (info?.activation === "disabled") continue;
    let provider = grouped.get(model.providerID);
    if (!provider) {
      provider = {
        id: model.providerID,
        name: v2OptionalString(info?.name) ?? model.providerID,
        source: "api",
        env: [],
        options: {},
        models: {},
      };
      grouped.set(model.providerID, provider);
    }
    Object.defineProperty(provider.models, model.id, {
      value: model,
      enumerable: true,
      configurable: true,
    });
  }
  return { all: [...grouped.values()], connected: [...grouped.keys()], default: {} };
}

export function normalizeOpenCodeV2Agents(value: unknown): Agent[] {
  return v2Array(value, "agents").map((entry) => {
    const agent = v2Object(entry, "agent");
    const mode = agent.mode;
    if (mode !== "all" && mode !== "primary" && mode !== "subagent")
      throw new Error("Invalid OpenCode v2 agent.mode");
    const model = agent.model === undefined ? undefined : v2Object(agent.model, "agent.model");
    const description = v2OptionalString(agent.description);
    const color = v2OptionalString(agent.color);
    const steps = v2OptionalNumber(agent.steps);
    const prompt = v2OptionalString(agent.system);
    const variant = v2OptionalString(model?.variant);
    return {
      name: v2String(agent.id, "agent.id"),
      ...(description === undefined ? {} : { description }),
      mode,
      hidden: v2Boolean(agent.hidden ?? false, "agent.hidden"),
      ...(color === undefined ? {} : { color }),
      ...(steps === undefined ? {} : { steps }),
      ...(prompt === undefined ? {} : { prompt }),
      permission: normalizeOpenCodeV2PermissionRules(agent.permissions),
      ...(model
        ? {
            model: {
              modelID: v2String(model.id, "agent.model.id"),
              providerID: v2String(model.providerID, "agent.model.providerID"),
            },
          }
        : {}),
      ...(variant === undefined ? {} : { variant }),
      options: v2OptionalObject(agent.request),
    };
  });
}

export function normalizeOpenCodeV2Path(value: unknown): Path {
  const location = v2Object(v2Data(value), "location");
  const project = v2OptionalObject(location.project);
  return {
    directory: v2String(location.directory, "location.directory"),
    worktree: v2String(project.directory ?? location.directory, "location.project.directory"),
    home: "",
    state: "",
    config: "",
  };
}

export function normalizeOpenCodeV2Commands(value: unknown): Command[] {
  return v2Array(value, "commands").map((entry) => {
    const command = v2Object(entry, "command");
    const description = v2OptionalString(command.description);
    return {
      name: v2String(command.name, "command.name"),
      ...(description === undefined ? {} : { description }),
      template: "",
      hints: [],
    };
  });
}
