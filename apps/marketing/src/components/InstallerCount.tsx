"use client";

import { startTransition, useEffect, useState } from "react";

const INSTALLER_COUNT_ENDPOINT = "/api/installer-count";
const POLL_INTERVAL_MS = 30000;

function formatInstallerCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

type InstallerCountProps = {
  initialCount: number | null;
};

export default function InstallerCount({ initialCount }: InstallerCountProps) {
  const [count, setCount] = useState<number | null>(initialCount);

  useEffect(() => {
    let isActive = true;

    async function refreshCount() {
      try {
        const response = await fetch(INSTALLER_COUNT_ENDPOINT, {
          cache: "no-store",
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as { count?: number };

        if (!isActive || typeof data.count !== "number") {
          return;
        }

        const nextCount = data.count;

        startTransition(() => {
          setCount(nextCount);
        });
      } catch {
        // Keep the last known value on network errors.
      }
    }

    void refreshCount();

    const intervalId = window.setInterval(() => {
      void refreshCount();
    }, POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  if (count === null || count <= 0) {
    return <span>Already downloaded by developers across macOS, Windows, and Linux.</span>;
  }

  return (
    <span>
      Already downloaded by{" "}
      <span className="font-medium text-[var(--text-primary)]">
        {formatInstallerCount(count)} people
      </span>
    </span>
  );
}
