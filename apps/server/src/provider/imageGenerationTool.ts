const IMAGE_GENERATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "image_gen",
  "image_edit",
  "generate_image",
]);

// Presentation only: names do not authorize execution or establish an image artifact.
export function isImageGenerationToolName(value: unknown): boolean {
  return typeof value === "string" && IMAGE_GENERATION_TOOL_NAMES.has(value.trim().toLowerCase());
}
