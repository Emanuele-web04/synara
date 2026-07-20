// FILE: AcpElicitationSupport.ts
// Purpose: Bridges ACP form elicitation schemas to Synara's provider-neutral question UI.
// Layer: Provider ACP protocol mapping
// Exports: question extraction and typed ACP response construction.

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";
import type * as Acp from "@agentclientprotocol/sdk";

type FormElicitationRequest = Acp.ElicitationFormMode & {
  readonly mode: "form";
  readonly message: string;
  readonly _meta?: Record<string, unknown> | null;
};
type ElicitationProperty = Acp.ElicitationPropertySchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function isFormElicitationRequest(
  request: Acp.CreateElicitationRequest,
): request is FormElicitationRequest {
  return (
    request.mode === "form" && "requestedSchema" in request && isRecord(request.requestedSchema)
  );
}

function propertyOptions(property: ElicitationProperty): ReadonlyArray<{
  readonly label: string;
  readonly description: string;
}> {
  if (property.type === "string") {
    const oneOf = property.oneOf;
    if (Array.isArray(oneOf)) {
      return oneOf.flatMap((option) => {
        if (!isRecord(option)) return [];
        const label = trimmedString(option.const);
        if (!label) return [];
        return [{ label, description: trimmedString(option.title) ?? label }];
      });
    }
    const enumValues = property.enum;
    return Array.isArray(enumValues)
      ? enumValues.flatMap((value) =>
          typeof value === "string" ? [{ label: value, description: value }] : [],
        )
      : [];
  }
  if (property.type === "array") {
    const items = property.items;
    if (!isRecord(items)) return [];
    const enumValues = items.enum;
    if (Array.isArray(enumValues)) {
      return enumValues.flatMap((value) =>
        typeof value === "string" ? [{ label: value, description: value }] : [],
      );
    }
    const anyOf = items.anyOf;
    return Array.isArray(anyOf)
      ? anyOf.flatMap((option) => {
          if (!isRecord(option)) return [];
          const label = trimmedString(option.const);
          if (!label) return [];
          return [{ label, description: trimmedString(option.title) ?? label }];
        })
      : [];
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  return [];
}

// Converts primitive ACP form fields into the question shape consumed by Synara's composer.
export function elicitationQuestionsFromRequest(
  request: FormElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  const properties = request.requestedSchema.properties ?? {};
  return Object.entries(properties).map(([id, property], index) => ({
    id,
    header: trimmedString(property.title) ?? `Question ${index + 1}`,
    question: trimmedString(property.description) ?? request.message,
    options: propertyOptions(property),
    multiSelect: property.type === "array",
  }));
}

function firstAnswerValue(value: ProviderUserInputAnswers[string] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function coerceElicitationAnswer(
  property: ElicitationProperty,
  answer: ProviderUserInputAnswers[string] | undefined,
): Acp.ElicitationContentValue | undefined {
  if (answer === null || answer === undefined) {
    return undefined;
  }
  if (property.type === "array") {
    return typeof answer === "string" ? [answer] : [...answer];
  }
  const value = firstAnswerValue(answer);
  if (value === undefined) {
    return undefined;
  }
  if (property.type === "boolean") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(normalized)) return true;
    if (["false", "no", "0", "off"].includes(normalized)) return false;
    return undefined;
  }
  if (property.type === "number" || property.type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (property.type === "integer" && !Number.isInteger(parsed))) {
      return undefined;
    }
    return parsed;
  }
  return value;
}

// Preserves the ACP property's primitive type instead of returning every UI answer as text.
export function elicitationResponseFromAnswers(
  request: FormElicitationRequest,
  answers: ProviderUserInputAnswers,
): Acp.CreateElicitationResponse {
  const content: Record<string, Acp.ElicitationContentValue> = {};
  for (const [id, property] of Object.entries(request.requestedSchema.properties ?? {})) {
    const value = coerceElicitationAnswer(property, answers[id]);
    if (value !== undefined) {
      content[id] = value;
    }
  }
  return {
    action: "accept",
    content,
  };
}
