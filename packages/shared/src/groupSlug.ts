const FALLBACK_GROUP_SLUG = "group";
const MAX_GROUP_SLUG_LENGTH = 72;

export function slugifyGroupTitle(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const truncated = normalized.slice(0, MAX_GROUP_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated || FALLBACK_GROUP_SLUG;
}
