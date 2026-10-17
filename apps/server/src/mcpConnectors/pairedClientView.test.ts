import type { McpConnector } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { connectorsForPairedClient } from "./pairedClientView";

const connector = (url: string): McpConnector =>
  ({
    connectorId: "vercel",
    presetId: "vercel",
    name: "Vercel",
    url,
    serverName: "vercel_connector",
    authKind: "oauth",
    status: "connected",
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
  }) as McpConnector;

describe("connectorsForPairedClient", () => {
  it("keeps only the origin of each connector URL", () => {
    const [view] = connectorsForPairedClient([
      connector("https://user:secret@mcp.example.com/sk-live-123/mcp?token=abc"),
    ]);
    expect(view?.url).toBe("https://mcp.example.com");
    expect(JSON.stringify(view)).not.toMatch(/secret|sk-live|token/);
    expect(view?.serverName).toBe("vercel_connector");
  });

  it("drops a connector whose URL has no origin", () => {
    expect(connectorsForPairedClient([connector("not a url"), connector("file:///etc")])).toEqual(
      [],
    );
  });
});
