import type {
  AgentInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  PermissionRuleset as V2Rules,
  PermissionRequest as V2Permission,
  FormInfo,
  FormAnswer,
} from "@opencode/client";
import type {
  Agent,
  PermissionRuleset,
  PermissionRequest,
  QuestionRequest,
  QuestionAnswer,
  Session,
} from "@opencode-ai/sdk/v2";
import type { OpenCodeModelInventory } from "./OpenCodeDiscovery.ts";

const nativeActions: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
};

export function openCodeV2Rules(rules: PermissionRuleset): V2Rules {
  return rules.map(({ permission, pattern, action }) => ({
    action: nativeActions[permission] ?? permission,
    resource: pattern,
    effect: action,
  }));
}

export function openCodeV2Session(session: SessionInfo): Session {
  return {
    ...session,
    slug: session.id,
    title: session.title ?? "",
    version: "2",
    directory: session.location.directory,
    ...(session.permissions
      ? {
          permission: session.permissions.map(({ action, resource, effect }) => ({
            permission: action,
            pattern: resource,
            action: effect,
          })),
        }
      : {}),
  };
}

export function openCodeV2Inventory(
  providers: ProviderInfo[],
  models: ModelInfo[],
): OpenCodeModelInventory["providerList"] {
  const enabled = models.filter((model) => model.enabled);
  return {
    connected: providers
      .filter((provider) => enabled.some((model) => model.providerID === provider.id))
      .map((provider) => provider.id),
    all: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.fromEntries(
        enabled
          .filter((model) => model.providerID === provider.id)
          .map((model) => [
            model.id,
            {
              id: model.id,
              name: model.name,
              limit: model.limit,
              capabilities: { reasoning: model.variants.length > 0 },
              // Provider settings/headers may contain credentials; the picker needs
              // only variant IDs, never the provider's raw request configuration.
              variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
            },
          ]),
      ),
    })),
  };
}

export function openCodeV2Agent(agent: AgentInfo): Agent {
  return {
    name: agent.id,
    mode: agent.mode,
    hidden: agent.hidden,
    options: {},
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.color !== undefined ? { color: agent.color } : {}),
    ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    permission: agent.permissions.map(({ action, resource, effect }) => ({
      permission: action,
      pattern: resource,
      action: effect,
    })),
    ...(agent.model
      ? {
          model: { providerID: agent.model.providerID, modelID: agent.model.id },
          ...(agent.model.variant ? { variant: agent.model.variant } : {}),
        }
      : {}),
  };
}

export function openCodeV2Permission(request: V2Permission): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action === "shell" ? "bash" : request.action,
    patterns: request.resources,
    always: request.save ?? [],
    metadata: request.metadata ?? {},
    ...(request.source
      ? { tool: { messageID: request.source.messageID, callID: request.source.id } }
      : {}),
  };
}

export function isUnsupportedOpenCodeV2Form(form: FormInfo): boolean {
  return form.fields.some(
    (field) => field.type === "external" || field.hidden || field.when?.length,
  );
}

/** Keep unrepresentable native forms visible and cancellable without acting on another session. */
export function openCodeV2Question(form: FormInfo): QuestionRequest {
  if (isUnsupportedOpenCodeV2Form(form))
    return {
      id: form.id,
      sessionID: form.sessionID,
      questions: [
        {
          header: form.title,
          question: "This form needs OpenCode's interface. Complete it there, or cancel it here.",
          options: [{ label: "Cancel", description: "Cancel this OpenCode form" }],
          custom: false,
        },
      ],
    };
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field) => {
      if (field.type === "external" || field.hidden || field.when?.length) {
        throw new Error(
          `OpenCode form ${form.id} requires an unsupported external, hidden, or conditional field.`,
        );
      }
      const options =
        field.type === "boolean"
          ? [
              { label: "true", description: "Yes" },
              { label: "false", description: "No" },
            ]
          : "options" in field
            ? (field.options ?? []).map((option) => ({
                label: option.label ?? option.value,
                description: option.description ?? option.value,
              }))
            : [];
      return {
        header: field.title ?? form.title,
        question: field.description ?? field.title ?? field.key,
        options,
        multiple: field.type === "multiselect",
        custom:
          field.type !== "boolean" &&
          (!("options" in field) || options.length === 0 || field.custom === true),
      };
    }),
  };
}

export function openCodeV2Answer(form: FormInfo, answers: QuestionAnswer[]): FormAnswer {
  // Validate that the request is representable before mapping positional answers.
  if (isUnsupportedOpenCodeV2Form(form))
    throw new Error("This form must be completed in OpenCode or cancelled.");
  const result: FormAnswer = {};
  for (const [index, field] of form.fields.entries()) {
    const values = answers[index] ?? [];
    if (values.length === 0) {
      if ("required" in field && field.required)
        throw new Error(`OpenCode requires an answer for ${field.key}.`);
      continue;
    }
    const mapped = values.map((value) =>
      "options" in field
        ? (field.options?.find((option) => (option.label ?? option.value) === value)?.value ??
          value)
        : value,
    );
    if (field.type === "multiselect") result[field.key] = mapped;
    else if (field.type === "boolean") {
      if (mapped[0] !== "true" && mapped[0] !== "false")
        throw new Error(`Invalid boolean answer for ${field.key}.`);
      result[field.key] = mapped[0] === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const value = Number(mapped[0]);
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
        throw new Error(`Invalid numeric answer for ${field.key}.`);
      }
      result[field.key] = value;
    } else result[field.key] = mapped.join(", ");
  }
  return result;
}
