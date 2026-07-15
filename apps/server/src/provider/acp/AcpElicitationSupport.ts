// FILE: AcpElicitationSupport.ts
// Purpose: Bridges ACP form elicitation schemas to Synara's provider-neutral question UI.
// Layer: Provider ACP protocol mapping
// Exports: question extraction and typed ACP response construction.

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

type FormElicitationRequest = Extract<
  EffectAcpSchema.ElicitationRequest,
  { readonly mode: "form" }
>;
type ElicitationProperty = EffectAcpSchema.ElicitationPropertySchema;

function propertyOptions(property: ElicitationProperty): ReadonlyArray<{
  readonly label: string;
  readonly description: string;
}> {
  if (property.type === "string") {
    if (property.oneOf) {
      return property.oneOf.map((option) => ({
        label: option.const,
        description: option.title,
      }));
    }
    return (property.enum ?? []).map((value) => ({ label: value, description: value }));
  }
  if (property.type === "array") {
    const entries = "enum" in property.items ? property.items.enum : property.items.anyOf;
    return entries.map((option) =>
      typeof option === "string"
        ? { label: option, description: option }
        : { label: option.const, description: option.title },
    );
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
    header: property.title?.trim() || `Question ${index + 1}`,
    question: property.description?.trim() || request.message,
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
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (answer === null || answer === undefined) {
    return undefined;
  }
  if (property.type === "array") {
    return typeof answer === "string" ? [answer] : answer;
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
): EffectAcpSchema.ElicitationResponse {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [id, property] of Object.entries(request.requestedSchema.properties ?? {})) {
    const value = coerceElicitationAnswer(property, answers[id]);
    if (value !== undefined) {
      content[id] = value;
    }
  }
  return {
    action: {
      action: "accept",
      content,
    },
  };
}
