import type { ShellSnapshot, ThreadStatus, ThreadSummary } from "../domain";

export const pairingTokenLength = 12;

export function normalizePairingToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, pairingTokenLength);
}

export function tokenFromLocationHash(hash: string): string {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return normalizePairingToken(params.get("token") ?? "");
}

// Keep the pairing credential only in volatile memory and remove it from the
// address bar before session discovery or rendering can retain the URL.
let capturedPairingToken = "";

export function capturePairingTokenFromHash(hash: string, clearFragment: () => void): void {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (!params.has("token")) return;
  capturedPairingToken = normalizePairingToken(params.get("token") ?? "");
  clearFragment();
}

export function takeCapturedPairingToken(): string {
  const token = capturedPairingToken;
  capturedPairingToken = "";
  return token;
}

export function makeRequestId(): string {
  return crypto.randomUUID();
}

export function needsAttention(status: ThreadStatus): boolean {
  return status === "waiting-approval" || status === "waiting-input" || status === "failed";
}

export function sortThreads(threads: readonly ThreadSummary[]): readonly ThreadSummary[] {
  return [...threads].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function projectThreads(
  shell: ShellSnapshot,
  projectId: string,
): readonly ThreadSummary[] {
  return sortThreads(shell.threads.filter((thread) => thread.projectId === projectId));
}

export function statusLabel(status: ThreadStatus): string {
  switch (status) {
    case "waiting-approval":
      return "Approval needed";
    case "waiting-input":
      return "Input needed";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "Ready";
  }
}

export function relativeTime(isoDate: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(isoDate));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "Just now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(isoDate),
  );
}

export function safeExternalUrl(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
