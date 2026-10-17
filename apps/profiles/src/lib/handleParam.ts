/**
 * The trysynara.com rewrite delivers `/@dylan` as the `handle` segment, so
 * the raw param arrives URL-encoded with its @ ("%40dylan"). Anything that
 * does not carry the @ is not a profile URL this app serves. Shared by the
 * page, its social preview and its share images.
 */
export function handleFromParam(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const handle = decoded.slice(1).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handle) ? handle : null;
}
