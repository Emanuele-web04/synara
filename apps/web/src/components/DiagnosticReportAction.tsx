import type { DesktopDiagnosticReportStatus } from "@synara/contracts";
import { useEffect, useState } from "react";
import { CopyTextButton } from "./ui/copyTextButton";

export function DiagnosticReportAction({ id }: { id: string }) {
  const [report, setReport] = useState<{
    id: string;
    status: DesktopDiagnosticReportStatus;
  } | null>(null);
  const status = report?.id === id ? report.status : "queued";
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      let next: DesktopDiagnosticReportStatus = "unavailable";
      try {
        next =
          (await window.desktopBridge?.betaDiagnostics?.getReportStatus?.(id)) ?? "unavailable";
      } catch {
        /* Do not replace the original failure with a diagnostics error. */
      }
      if (disposed) return;
      setReport({ id, status: next });
      if (next === "queued") timer = setTimeout(() => void check(), 5_000);
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-ui-xs text-muted-foreground">
      <CopyTextButton text={id} label="diagnostic ID" />
      <span>
        {status === "sent"
          ? "Report sent"
          : status === "queued"
            ? "Report queued locally"
            : "Upload not confirmed"}
      </span>
    </span>
  );
}
