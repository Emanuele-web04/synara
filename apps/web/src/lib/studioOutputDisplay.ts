const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;
const LEADING_DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}[_\-\s]*/;

export function humanizeStudioOutputName(fileName: string): string {
  const withoutExtension = fileName.replace(FILE_EXTENSION_PATTERN, "");
  const withoutDatePrefix = withoutExtension.replace(LEADING_DATE_PREFIX_PATTERN, "");
  const spaced = withoutDatePrefix.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const base = spaced.length > 0 ? spaced : withoutExtension.trim();
  if (base.length === 0) {
    return fileName;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}
