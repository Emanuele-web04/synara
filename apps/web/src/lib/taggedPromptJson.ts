export function escapeJsonForTaggedBlock(json: string): string {
  return json.replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
