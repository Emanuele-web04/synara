// FILE: InstallerCount.tsx
// Purpose: Shows the installer total rendered by the server.
// Layer: Presentation component
// Notes: The count is a once-a-day number (see lib/installerCount.ts), so the
//        browser no longer polls /api/installer-count every 30s; the value the
//        page was rendered with is the value to show.

function formatInstallerCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

type InstallerCountProps = {
  initialCount: number | null;
};

export default function InstallerCount({ initialCount }: InstallerCountProps) {
  if (initialCount === null || initialCount <= 0) {
    return <span>Already downloaded by developers across macOS, Windows, and Linux.</span>;
  }

  return (
    <span>
      Already downloaded by{" "}
      <span className="font-medium text-[var(--text-primary)]">
        {formatInstallerCount(initialCount)} people
      </span>
    </span>
  );
}
