// the server ranker and web highlighter must agree on the query — when they drift a result matches server-side but renders with no emphasis
// entry-name search only — content search doesn't strip prefixes and filesystem search has its own dotfile semantics

/** trims, strips leading "@"/"."/"/" prefixes, lowercases */
export function normalizeWorkspaceEntrySearchQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}
