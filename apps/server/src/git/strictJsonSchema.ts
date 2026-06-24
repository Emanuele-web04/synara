import { Schema } from "effect";

// effect's `Schema.toJsonSchemaDocument` emits a JSON Schema that OpenAI strict
// structured-output mode rejects on two counts, both of which 400 the `codex exec
// --output-schema` request:
//   1. `Schema.optional` keys are dropped from `required`; strict mode requires every
//      `properties` key to appear in `required` (optionals are expressed as nullable,
//      which the document already does via `anyOf [..., null]`).
//   2. value constraints (`isGreaterThanOrEqualTo`, `isMaxLength`, regex patterns) are
//      emitted as `allOf: [{ minimum: 0 }, …]`; strict mode forbids `allOf`.
// This recursive transform forces full `required` and hoists those constraint objects
// up into the parent node, dropping `allOf`. The constraints are advisory for codex —
// the effect Schema re-validates them on decode — so flattening them is lossless.
function applyStrictRequired(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(applyStrictRequired);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const record = node as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "allOf") {
      continue;
    }
    next[key] = applyStrictRequired(value);
  }

  const allOf = record["allOf"];
  if (Array.isArray(allOf)) {
    // allOf is an intersection: when the same constraint key appears more than once,
    // keep the tightest bound rather than silently dropping later values.
    const tightenMax = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
    const tightenMin = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);
    for (const entry of allOf) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        for (const [constraintKey, constraintValue] of Object.entries(
          entry as Record<string, unknown>,
        )) {
          const existing = next[constraintKey];
          if (!(constraintKey in next)) {
            next[constraintKey] = constraintValue;
          } else if (typeof existing === "number" && typeof constraintValue === "number") {
            if (tightenMax.has(constraintKey)) {
              next[constraintKey] = Math.max(existing, constraintValue);
            } else if (tightenMin.has(constraintKey)) {
              next[constraintKey] = Math.min(existing, constraintValue);
            }
          }
        }
      }
    }
  }

  const properties = next["properties"];
  if (next["type"] === "object" && properties !== null && typeof properties === "object") {
    next["required"] = Object.keys(properties as Record<string, unknown>);
  }

  return next;
}

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  const schemaObject =
    document.definitions && Object.keys(document.definitions).length > 0
      ? { ...document.schema, $defs: document.definitions }
      : document.schema;
  return applyStrictRequired(schemaObject);
}

// Strict structured output makes the model emit `null` for absent `Schema.optional`
// fields, but the decode treats `Schema.optional(X)` as "key absent", not "key present
// and null", so a present `null` is rejected. This drops a null-valued key only when the
// schema marks that key optional (AST `context.isOptional`), mapping the wire shape back
// to the contract shape (`field?: T`). `Schema.NullOr` keys are NOT optional in the AST,
// so their legitimate `null` is preserved. Walks the schema AST alongside the JSON so the
// transform is schema-aware and safe for every operation.
type SchemaAstNode = {
  readonly _tag?: string;
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: string;
    readonly type?: { readonly context?: { readonly isOptional?: boolean } } & SchemaAstNode;
  }>;
  // For `Schema.Array`, the element AST node is `rest[0]` directly (it carries
  // `propertySignatures`); `.type` covers tuple-style element wrappers.
  readonly rest?: ReadonlyArray<SchemaAstNode & { readonly type?: SchemaAstNode }>;
  readonly types?: ReadonlyArray<SchemaAstNode>;
};

function stripNullForAst(value: unknown, ast: SchemaAstNode | undefined): unknown {
  if (ast === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    const restEntry = ast.rest?.[0];
    const elementAst = restEntry?.type ?? restEntry;
    return value.map((item) => stripNullForAst(item, elementAst));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  // A union (NullOr, schedule variants, …) wraps the real object shape; descend into the
  // member whose property set best matches this value so optional flags stay accurate.
  const objectAst = resolveObjectAst(ast, value as Record<string, unknown>);
  const signatures = objectAst?.propertySignatures;
  if (!signatures) {
    return value;
  }

  const optionalByName = new Map(
    signatures.map((signature) => [signature.name, signature.type?.context?.isOptional === true]),
  );
  const astByName = new Map(signatures.map((signature) => [signature.name, signature.type]));

  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === null && optionalByName.get(key) === true) {
      continue;
    }
    next[key] = stripNullForAst(nested, astByName.get(key));
  }
  return next;
}

function resolveObjectAst(
  ast: SchemaAstNode,
  value: Record<string, unknown>,
): SchemaAstNode | undefined {
  if (ast.propertySignatures) {
    return ast;
  }
  if (ast.types) {
    const candidates = ast.types
      .map((member) => resolveObjectAst(member, value))
      .filter((member): member is SchemaAstNode => member?.propertySignatures !== undefined);
    if (candidates.length <= 1) {
      return candidates[0];
    }
    return (
      candidates.find((member) =>
        (member.propertySignatures ?? []).every((signature) => signature.name in value),
      ) ?? candidates[0]
    );
  }
  return undefined;
}

export function stripNullOptionalFields<S extends Schema.Top>(schema: S, value: unknown): unknown {
  return stripNullForAst(value, schema.ast as unknown as SchemaAstNode);
}
