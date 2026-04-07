import type { Terminal } from "@xterm/xterm";

/**
 * Suppress terminal query responses that leak as visible garbage text.
 *
 * Only suppresses sequences where the response uses a DIFFERENT final byte
 * than the query, so we never accidentally eat real commands.
 *
 * - CSI R  — Cursor Position Report (query is CSI 6n)
 * - CSI I  — Focus In report (mode 1004, no query)
 * - CSI O  — Focus Out report (mode 1004, no query)
 * - CSI $y — Mode Report (query is CSI $p)
 */
export function suppressQueryResponses(terminal: Terminal): () => void {
  const disposables: { dispose(): void }[] = [];
  const p = terminal.parser;

  disposables.push(p.registerCsiHandler({ final: "R" }, () => true));
  disposables.push(p.registerCsiHandler({ final: "I" }, () => true));
  disposables.push(p.registerCsiHandler({ final: "O" }, () => true));
  disposables.push(p.registerCsiHandler({ intermediates: "$", final: "y" }, () => true));

  return () => {
    for (const d of disposables) d.dispose();
  };
}
